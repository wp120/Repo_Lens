export function buildCitationUrl(
  repositoryUrl: string,
  commitSha: string,
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  if (!repositoryUrl || !/^[0-9a-f]{7,40}$/i.test(commitSha)) return "";

  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const anchor =
    startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
  return `${repositoryUrl.replace(/\/$/, "")}/blob/${commitSha}/${encodedPath}?plain=1${anchor}`;
}
