import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto"

const params = {
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: {
    cost: number
    blockSize: number
    parallelization: number
    maxmem: number
  }
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) {
        reject(error)
        return
      }

      resolve(key)
    })
  })
}

export function isStrongPassword(password: string) {
  return (
    password.length >= 32 &&
    password.length <= 1024 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

export async function hashPassword(password: string) {
  if (!isStrongPassword(password)) {
    throw new Error("Password does not meet the account policy")
  }

  const salt = randomBytes(16)
  const derived = await deriveKey(password, salt, params.keyLength, {
    cost: params.cost,
    blockSize: params.blockSize,
    parallelization: params.parallelization,
    maxmem: 64 * 1024 * 1024,
  })

  return [
    "scrypt",
    params.cost,
    params.blockSize,
    params.parallelization,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$")
}

export async function verifyPassword(password: string, storedHash: string) {
  if (!password || password.length > 1024) {
    return false
  }

  const [scheme, cost, blockSize, parallelization, salt, hash] =
    storedHash.split("$")

  if (scheme !== "scrypt" || !cost || !blockSize || !parallelization) {
    return false
  }

  const parsedCost = Number.parseInt(cost, 10)
  const parsedBlockSize = Number.parseInt(blockSize, 10)
  const parsedParallelization = Number.parseInt(parallelization, 10)

  if (
    !Number.isInteger(parsedCost) ||
    !Number.isInteger(parsedBlockSize) ||
    !Number.isInteger(parsedParallelization) ||
    parsedCost <= 0 ||
    parsedBlockSize <= 0 ||
    parsedParallelization <= 0
  ) {
    return false
  }

  const expected = Buffer.from(hash ?? "", "base64url")

  if (!expected.length) {
    return false
  }

  let derived: Buffer

  try {
    derived = await deriveKey(
      password,
      Buffer.from(salt ?? "", "base64url"),
      expected.length,
      {
        cost: parsedCost,
        blockSize: parsedBlockSize,
        parallelization: parsedParallelization,
        maxmem: 64 * 1024 * 1024,
      }
    )
  } catch {
    return false
  }

  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  )
}
