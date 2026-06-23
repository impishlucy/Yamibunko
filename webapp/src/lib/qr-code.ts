const dataCodewordsByVersion = [0, 19, 34, 55, 80, 108]
const errorCodewordsByVersion = [0, 7, 10, 15, 20, 26]
const alignmentPatternCentersByVersion: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
}

const gfExp = new Array<number>(512)
const gfLog = new Array<number>(256)

let value = 1
for (let index = 0; index < 255; index += 1) {
  gfExp[index] = value
  gfLog[value] = index
  value <<= 1

  if (value & 0x100) {
    value ^= 0x11d
  }
}

for (let index = 255; index < 512; index += 1) {
  gfExp[index] = gfExp[index - 255]
}

function gfMultiply(left: number, right: number) {
  if (left === 0 || right === 0) {
    return 0
  }

  return gfExp[gfLog[left] + gfLog[right]]
}

function reedSolomonGenerator(degree: number) {
  let result = [1]

  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(result.length + 1).fill(0)

    for (let resultIndex = 0; resultIndex < result.length; resultIndex += 1) {
      next[resultIndex] ^= result[resultIndex]
      next[resultIndex + 1] ^= gfMultiply(result[resultIndex], gfExp[index])
    }

    result = next
  }

  return result
}

function reedSolomonRemainder(data: number[], degree: number) {
  const generator = reedSolomonGenerator(degree)
  const result = new Array<number>(degree).fill(0)

  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)

    for (let index = 0; index < degree; index += 1) {
      result[index] ^= gfMultiply(generator[index + 1], factor)
    }
  }

  return result
}

function appendBits(bits: number[], value: number, length: number) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push((value >>> index) & 1)
  }
}

function getDataBytes(data: string, version: number) {
  const encoder = new TextEncoder()
  const bytes = Array.from(encoder.encode(data))
  const capacityBits = dataCodewordsByVersion[version] * 8
  const bits: number[] = []

  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, 8)

  for (const byte of bytes) {
    appendBits(bits, byte, 8)
  }

  if (bits.length > capacityBits) {
    return null
  }

  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))

  while (bits.length % 8 !== 0) {
    bits.push(0)
  }

  const dataBytes: number[] = []

  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0

    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      byte = (byte << 1) | bits[index + bitIndex]
    }

    dataBytes.push(byte)
  }

  for (let padIndex = 0; dataBytes.length < dataCodewordsByVersion[version]; padIndex += 1) {
    dataBytes.push(padIndex % 2 === 0 ? 0xec : 0x11)
  }

  return dataBytes
}

function pickVersion(data: string) {
  for (let version = 1; version <= 5; version += 1) {
    if (getDataBytes(data, version)) {
      return version
    }
  }

  throw new Error("QR payload is too long")
}

type QrMatrix = {
  modules: number[][]
  reserved: boolean[][]
  size: number
}

function createMatrix(version: number): QrMatrix {
  const size = version * 4 + 17

  return {
    modules: Array.from({ length: size }, () => new Array<number>(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    size,
  }
}

function setFunctionModule(matrix: QrMatrix, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) {
    return
  }

  matrix.modules[y][x] = dark ? 1 : 0
  matrix.reserved[y][x] = true
}

function drawFinderPattern(matrix: QrMatrix, left: number, top: number) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const absoluteX = left + x
      const absoluteY = top + y
      const isFinder =
        x >= 0 &&
        x <= 6 &&
        y >= 0 &&
        y <= 6 &&
        (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4))

      setFunctionModule(matrix, absoluteX, absoluteY, isFinder)
    }
  }
}

function drawAlignmentPattern(matrix: QrMatrix, centerX: number, centerY: number) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y))
      setFunctionModule(matrix, centerX + x, centerY + y, distance !== 1)
    }
  }
}

function drawFunctionPatterns(matrix: QrMatrix, version: number) {
  drawFinderPattern(matrix, 0, 0)
  drawFinderPattern(matrix, matrix.size - 7, 0)
  drawFinderPattern(matrix, 0, matrix.size - 7)

  for (let index = 8; index < matrix.size - 8; index += 1) {
    const dark = index % 2 === 0
    setFunctionModule(matrix, index, 6, dark)
    setFunctionModule(matrix, 6, index, dark)
  }

  for (const centerY of alignmentPatternCentersByVersion[version]) {
    for (const centerX of alignmentPatternCentersByVersion[version]) {
      if (matrix.reserved[centerY]?.[centerX]) {
        continue
      }

      drawAlignmentPattern(matrix, centerX, centerY)
    }
  }

  drawFormatBits(matrix, 0)
  setFunctionModule(matrix, 8, version * 4 + 9, true)
}

function getFormatBits(mask: number) {
  const data = (1 << 3) | mask
  let bits = data << 10

  for (let index = 14; index >= 10; index -= 1) {
    if (((bits >>> index) & 1) !== 0) {
      bits ^= 0x537 << (index - 10)
    }
  }

  return ((data << 10) | bits) ^ 0x5412
}

function drawFormatBits(matrix: QrMatrix, mask: number) {
  const bits = getFormatBits(mask)

  for (let index = 0; index <= 5; index += 1) {
    setFunctionModule(matrix, 8, index, ((bits >>> index) & 1) !== 0)
  }

  setFunctionModule(matrix, 8, 7, ((bits >>> 6) & 1) !== 0)
  setFunctionModule(matrix, 8, 8, ((bits >>> 7) & 1) !== 0)
  setFunctionModule(matrix, 7, 8, ((bits >>> 8) & 1) !== 0)

  for (let index = 9; index <= 14; index += 1) {
    setFunctionModule(matrix, 14 - index, 8, ((bits >>> index) & 1) !== 0)
  }

  for (let index = 0; index <= 7; index += 1) {
    setFunctionModule(matrix, matrix.size - 1 - index, 8, ((bits >>> index) & 1) !== 0)
  }

  for (let index = 8; index <= 14; index += 1) {
    setFunctionModule(matrix, 8, matrix.size - 15 + index, ((bits >>> index) & 1) !== 0)
  }

  setFunctionModule(matrix, 8, matrix.size - 8, true)
}

function createCodewords(data: string, version: number) {
  const dataBytes = getDataBytes(data, version)

  if (!dataBytes) {
    throw new Error("QR payload does not fit selected version")
  }

  const errorCodewordCount = errorCodewordsByVersion[version]
  return [...dataBytes, ...reedSolomonRemainder(dataBytes, errorCodewordCount)]
}

function drawCodewords(matrix: QrMatrix, codewords: number[]) {
  const bits: number[] = []

  for (const codeword of codewords) {
    appendBits(bits, codeword, 8)
  }

  let bitIndex = 0
  let upward = true

  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1
    }

    for (let vertical = 0; vertical < matrix.size; vertical += 1) {
      const y = upward ? matrix.size - 1 - vertical : vertical

      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset

        if (matrix.reserved[y][x]) {
          continue
        }

        matrix.modules[y][x] = bits[bitIndex] ?? 0
        bitIndex += 1
      }
    }

    upward = !upward
  }
}

function shouldMask(mask: number, x: number, y: number) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function applyMask(source: QrMatrix, mask: number): QrMatrix {
  const matrix: QrMatrix = {
    size: source.size,
    modules: source.modules.map((row) => [...row]),
    reserved: source.reserved.map((row) => [...row]),
  }

  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.reserved[y][x] && shouldMask(mask, x, y)) {
        matrix.modules[y][x] ^= 1
      }
    }
  }

  drawFormatBits(matrix, mask)
  return matrix
}

function getPenaltyScore(matrix: QrMatrix) {
  let score = 0

  for (let y = 0; y < matrix.size; y += 1) {
    let runColor = matrix.modules[y][0]
    let runLength = 1

    for (let x = 1; x < matrix.size; x += 1) {
      if (matrix.modules[y][x] === runColor) {
        runLength += 1
      } else {
        if (runLength >= 5) {
          score += 3 + runLength - 5
        }

        runColor = matrix.modules[y][x]
        runLength = 1
      }
    }

    if (runLength >= 5) {
      score += 3 + runLength - 5
    }
  }

  for (let x = 0; x < matrix.size; x += 1) {
    let runColor = matrix.modules[0][x]
    let runLength = 1

    for (let y = 1; y < matrix.size; y += 1) {
      if (matrix.modules[y][x] === runColor) {
        runLength += 1
      } else {
        if (runLength >= 5) {
          score += 3 + runLength - 5
        }

        runColor = matrix.modules[y][x]
        runLength = 1
      }
    }

    if (runLength >= 5) {
      score += 3 + runLength - 5
    }
  }

  for (let y = 0; y < matrix.size - 1; y += 1) {
    for (let x = 0; x < matrix.size - 1; x += 1) {
      const color = matrix.modules[y][x]

      if (
        color === matrix.modules[y][x + 1] &&
        color === matrix.modules[y + 1][x] &&
        color === matrix.modules[y + 1][x + 1]
      ) {
        score += 3
      }
    }
  }

  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ]

  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x <= matrix.size - 11; x += 1) {
      const slice = matrix.modules[y].slice(x, x + 11)

      if (patterns.some((pattern) => pattern.every((value, index) => value === slice[index]))) {
        score += 40
      }
    }
  }

  for (let x = 0; x < matrix.size; x += 1) {
    for (let y = 0; y <= matrix.size - 11; y += 1) {
      const slice = Array.from({ length: 11 }, (_, index) => matrix.modules[y + index][x])

      if (patterns.some((pattern) => pattern.every((value, index) => value === slice[index]))) {
        score += 40
      }
    }
  }

  const darkCount = matrix.modules.flat().filter(Boolean).length
  const totalCount = matrix.size * matrix.size
  const darkPercent = (darkCount * 100) / totalCount
  score += Math.floor(Math.abs(darkPercent - 50) / 5) * 10

  return score
}

function createQrMatrix(data: string) {
  const version = pickVersion(data)
  const matrix = createMatrix(version)
  drawFunctionPatterns(matrix, version)
  drawCodewords(matrix, createCodewords(data, version))

  let bestMatrix = applyMask(matrix, 0)
  let bestScore = getPenaltyScore(bestMatrix)

  for (let mask = 1; mask < 8; mask += 1) {
    const candidate = applyMask(matrix, mask)
    const score = getPenaltyScore(candidate)

    if (score < bestScore) {
      bestMatrix = candidate
      bestScore = score
    }
  }

  return bestMatrix
}

function escapeSvgAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function createQrSvg(data: string) {
  const matrix = createQrMatrix(data)
  const quietZone = 4
  const size = matrix.size + quietZone * 2
  const paths: string[] = []

  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y][x]) {
        paths.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`)
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${escapeSvgAttribute(data)}"><path fill="#fff" d="M0,0h${size}v${size}h-${size}z"/><path fill="#000" d="${paths.join("")}"/></svg>`
}

export function createQrSvgDataUri(data: string) {
  return `data:image/svg+xml,${encodeURIComponent(createQrSvg(data))}`
}
