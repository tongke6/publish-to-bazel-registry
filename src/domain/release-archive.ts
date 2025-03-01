import axios, { AxiosError, AxiosResponse } from "axios";
import axiosRetry from "axios-retry";
import extractZip from "extract-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseUrl } from "node:url";
import tar from "tar";
import { UserFacingError } from "./error.js";
import { decompress as decompressXz } from "../infrastructure/xzdec/xzdec.js";

import { ModuleFile } from "./module-file.js";

export class UnsupportedArchiveFormat extends UserFacingError {
  constructor(extension: string) {
    super(`Unsupported release archive format ${extension}`);
  }
}

export class ArchiveDownloadError extends UserFacingError {
  constructor(url: string, statusCode: number) {
    let msg = `Failed to download release archive from ${url}. Received status ${statusCode}`;

    if (statusCode === 404) {
      msg +=
        "\n\nDouble check that the `url` in your ruleset's .bcr/source.template.json is correct. Also ensure that the release archive is uploaded as part of publishing the release rather than uploaded afterward.";
    }
    super(msg);
  }
}

export class MissingModuleFileError extends UserFacingError {
  constructor(pathInArchive: string, stripPrefix: string) {
    super(
      `Could not find MODULE.bazel in release archive at ${pathInArchive}.\nIs the strip prefix in source.template.json correct? (currently it's '${stripPrefix}')`
    );
  }
}

export class ReleaseArchive {
  public static async fetch(
    url: string,
    stripPrefix: string
  ): Promise<ReleaseArchive> {
    const filename = url.substring(url.lastIndexOf("/") + 1);
    const downloadedPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "archive-")),
      filename
    );
    await download(url, downloadedPath);

    return new ReleaseArchive(downloadedPath, stripPrefix);
  }

  private extractDir: string | undefined;

  private constructor(
    private readonly _diskPath: string,
    private readonly stripPrefix: string
  ) {}

  public async extractModuleFile(): Promise<ModuleFile> {
    this.extractDir = path.dirname(this._diskPath);

    if (this.isSupportedTarball()) {
      await this.extractReleaseTarball(this.extractDir);
    } else if (this._diskPath.endsWith(".zip")) {
      await this.extractReleaseZip(this.extractDir);
    } else {
      const extension = this._diskPath.split(".").slice(1).join(".");
      throw new UnsupportedArchiveFormat(extension);
    }

    const pathInArchive = path.join(this.stripPrefix, "MODULE.bazel");

    const extractedModulePath = path.join(this.extractDir, pathInArchive);

    if (!fs.existsSync(extractedModulePath)) {
      throw new MissingModuleFileError(`./${pathInArchive}`, this.stripPrefix);
    }

    return new ModuleFile(extractedModulePath);
  }

  private isSupportedTarball(): boolean {
    if (this._diskPath.endsWith(".tar.gz")) {
      return true;
    }
    if (this._diskPath.endsWith(".tar.xz")) {
      return true;
    }
    return false;
  }

  private async extractReleaseTarball(extractDir: string): Promise<void> {
    if (this._diskPath.endsWith(".tar.xz")) {
      const reader = fs.createReadStream(this._diskPath);
      const writer = tar.x({
        cwd: extractDir
      });
      await decompressXz(reader, writer);
      await new Promise(resolve => {
        writer.on('finish', resolve);
        writer.end();
      });
      
      return;
    }

    await tar.x({
      cwd: extractDir,
      file: this._diskPath,
    });
  }

  private async extractReleaseZip(extractDir: string): Promise<void> {
    await extractZip(this._diskPath, { dir: extractDir });
  }

  public get diskPath(): string {
    return this._diskPath;
  }

  /**
   * Delete the release archive and extracted contents
   */
  public cleanup(): void {
    fs.rmSync(this._diskPath, { force: true });

    if (this.extractDir) {
      fs.rmSync(this.extractDir, { force: true, recursive: true });
    }
  }
}

function exponentialDelay(
  retryCount: number,
  error: AxiosError | undefined
): number {
  // Default delay factor is 10 seconds, but can be overridden for testing.
  const delayFactor = Number(process.env.BACKOFF_DELAY_FACTOR) || 10_000;
  return axiosRetry.exponentialDelay(retryCount, error, delayFactor);
}

function defaultRetryPlus404(error: AxiosError): boolean {
  // Publish-to-BCR needs to support retrying when GitHub returns 404
  // in order to support automated release workflows that upload artifacts
  // within a minute or so of publishing a release.
  // Apart from this case, use the default retry condition.
  return error.response.status === 404 || axiosRetry.isNetworkOrIdempotentRequestError(error);
}

async function download(url: string, dest: string): Promise<void> {
  if (process.env.INTEGRATION_TESTING) {
    // Point downloads to the standin github server
    // during integration testing.
    const [host, port] =
      process.env.GITHUB_API_ENDPOINT.split("://")[1].split(":");

    const parsed = parseUrl(url);
    parsed.host = host;
    parsed.port = port;

    url = `http://${host}:${port}${parsed.path}`;
  }

  const writer = fs.createWriteStream(dest, { flags: "w" });

  // Retry the request in case the artifact is still being uploaded.
  // Exponential backoff with 3 retries and a delay factor of 10 seconds
  // gives you at least 70 seconds to upload a release archive.
  axiosRetry(axios, {
    retries: 3,
    retryDelay: exponentialDelay,
    shouldResetTimeout: true,
    retryCondition: defaultRetryPlus404,
  });

  let response: AxiosResponse;

  try {
    response = await axios.get(url, {
      responseType: "stream",
    });
  } catch (e: any) {
    // https://axios-http.com/docs/handling_errors
    if (e.response) {
      throw new ArchiveDownloadError(url, e.response.status);
    } else if (e.request) {
      throw new Error(`GET ${url} failed; no response received`);
    } else {
      throw new Error(`Failed to GET ${url} failed: ${e.message}`);
    }
  }

  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}
