import path from "node:path"

export function cleanPathValue(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

export function parsePathList(value: string) {
  return value
    .split(";")
    .map(cleanPathValue)
    .filter(Boolean)
}

export function resolvePathList(value: string) {
  return parsePathList(value).map((entry) => path.resolve(entry))
}

export function joinPathList(paths: string[]) {
  return paths.join(";")
}

export function isPathInsideDirectory(filePath: string, directory: string) {
  const relativePath = path.relative(
    path.resolve(directory),
    path.resolve(filePath)
  )

  return (
    relativePath === "" ||
    (!!relativePath &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  )
}
