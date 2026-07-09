import { v } from 'convex/values'

const TOKEN_PACKAGE_DEFINITIONS = {
  '50_tokens': {
    name: '50 Token Pack',
    productIdEnvironmentVariable: 'POLAR_PRODUCT_ID_50',
    tokens: 50,
    amount: 499,
    currency: 'usd',
  },
  '125_tokens': {
    name: '125 Token Pack',
    productIdEnvironmentVariable: 'POLAR_PRODUCT_ID_125',
    tokens: 125,
    amount: 999,
    currency: 'usd',
  },
} as const

export type TokenPackageKey = keyof typeof TOKEN_PACKAGE_DEFINITIONS

export const tokenPackageKeyValidator = v.union(v.literal('50_tokens'), v.literal('125_tokens'))

export function isTokenPackageKey(value: string): value is TokenPackageKey {
  return Object.prototype.hasOwnProperty.call(TOKEN_PACKAGE_DEFINITIONS, value)
}

export function getTokenPackageDefinition(packageKey: string) {
  if (!isTokenPackageKey(packageKey)) {
    throw new Error('Unknown token package')
  }

  return {
    key: packageKey,
    ...TOKEN_PACKAGE_DEFINITIONS[packageKey],
  }
}

export function getTokenPackage(
  packageKey: string,
  environment: Record<string, string | undefined> = process.env
) {
  const definition = getTokenPackageDefinition(packageKey)
  const productId = environment[definition.productIdEnvironmentVariable]?.trim()

  if (!productId) {
    throw new Error(`${definition.productIdEnvironmentVariable} is not configured`)
  }

  return {
    ...definition,
    productId,
  }
}

export function getPublicTokenPackages() {
  return Object.keys(TOKEN_PACKAGE_DEFINITIONS).map((packageKey) => {
    const definition = getTokenPackageDefinition(packageKey)
    return {
      id: definition.key,
      name: definition.name,
      tokens: definition.tokens,
      price: definition.amount,
      currency: definition.currency.toUpperCase(),
      pricePerToken: definition.amount / 100 / definition.tokens,
    }
  })
}
