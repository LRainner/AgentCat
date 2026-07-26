import { writeFile } from "node:fs/promises";

const [tag, output = "latest.json"] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

if (!tag || !repository || !token) {
  throw new Error("Usage: GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=... node scripts/generate-updater-manifest.mjs <tag> [output]");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers });
if (!releaseResponse.ok) throw new Error(`GitHub release request failed: ${releaseResponse.status}`);
const release = await releaseResponse.json();

function requireAsset(predicate, description) {
  const asset = release.assets.find((candidate) => predicate(candidate.name));
  if (!asset) throw new Error(`Missing ${description} in release ${tag}`);
  return asset;
}

async function signatureFor(asset) {
  const signatureAsset = requireAsset((name) => name === `${asset.name}.sig`, `${asset.name}.sig`);
  const response = await fetch(signatureAsset.browser_download_url, { headers });
  if (!response.ok) throw new Error(`Signature download failed for ${signatureAsset.name}: ${response.status}`);
  return (await response.text()).trim();
}

const macos = requireAsset((name) => name.endsWith(".app.tar.gz"), "macOS updater archive");
const windows = requireAsset((name) => name.endsWith("-setup.exe"), "Windows NSIS updater installer");
const [macosSignature, windowsSignature] = await Promise.all([signatureFor(macos), signatureFor(windows)]);

const manifest = {
  version: tag.replace(/^v/i, ""),
  notes: release.body ?? "",
  pub_date: release.published_at ?? new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature: macosSignature, url: macos.browser_download_url },
    "darwin-x86_64": { signature: macosSignature, url: macos.browser_download_url },
    "windows-x86_64": { signature: windowsSignature, url: windows.browser_download_url },
  },
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Generated ${output} for ${manifest.version}`);
