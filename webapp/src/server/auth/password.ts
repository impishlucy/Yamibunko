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

const passwordProofPattern = /^[a-f0-9]{64}$/i

function deriveKey(
  passwordProof: string,
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
    scryptCallback(passwordProof, salt, keyLength, options, (error, key) => {
      if (error) {
        reject(error)
        return
      }

      resolve(key)
    })
  })
}

export function isPasswordProof(value: string) {
  return passwordProofPattern.test(value)
}

export async function hashPasswordProof(passwordProof: string) {
  if (!isPasswordProof(passwordProof)) {
    throw new Error("Invalid password proof")
  }

  const salt = randomBytes(16)
  const derived = await deriveKey(passwordProof, salt, params.keyLength, {
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

export async function verifyPasswordProof(
  passwordProof: string,
  storedHash: string
) {
  if (!isPasswordProof(passwordProof)) {
    return false
  }

  const [scheme, cost, blockSize, parallelization, salt, hash] =
    storedHash.split("$")

  if (scheme !== "scrypt" || !cost || !blockSize || !parallelization) {
    return false
  }

  const expected = Buffer.from(hash ?? "", "base64url")

  if (!expected.length) {
    return false
  }

  const derived = await deriveKey(
    passwordProof,
    Buffer.from(salt ?? "", "base64url"),
    expected.length,
    {
      cost: Number.parseInt(cost, 10),
      blockSize: Number.parseInt(blockSize, 10),
      parallelization: Number.parseInt(parallelization, 10),
      maxmem: 64 * 1024 * 1024,
    }
  )

  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  )
}
