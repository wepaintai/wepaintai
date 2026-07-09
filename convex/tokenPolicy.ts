export const TOKEN_COSTS = {
  'ai-generation': 1,
  'background-removal': 1,
  'image-merge': 1,
} as const

export type TokenOperationType = keyof typeof TOKEN_COSTS

export function getTokenCost(operationType: TokenOperationType): number {
  return TOKEN_COSTS[operationType]
}

export function createTokenOperationKey(
  operationType: TokenOperationType,
  operationId: string
): string {
  if (!operationId.trim()) {
    throw new Error('Operation ID is required')
  }
  return `${operationType}:${operationId}`
}

export function assertPositiveTokenAmount(amount: number, label = 'Token amount'): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return amount
}

export function assertValidTokenBalance(balance: number): number {
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new Error('Token balance must be a non-negative safe integer')
  }
  return balance
}
