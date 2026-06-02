export const maxPasswordLength = 1024

export function isStrongPassword(password: string) {
  return (
    password.length >= 32 &&
    password.length <= maxPasswordLength &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}
