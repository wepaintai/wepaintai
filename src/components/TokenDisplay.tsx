import React, { useState } from 'react'
import { useQuery, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Coins, Loader2 } from 'lucide-react'

interface TokenDisplayProps {
  className?: string
}

export function TokenDisplay({ className = '' }: TokenDisplayProps) {
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  const [selectedPackageKey, setSelectedPackageKey] = useState<'50_tokens' | '125_tokens'>(
    '125_tokens'
  )

  // Always call hooks in the same order - this is a React requirement
  const tokenBalance = useQuery(api.tokens.getTokenBalance)
  const tokenPackages = useQuery(api.polar.getTokenPackages)
  const createCheckout = useAction(api.polar.createCheckout)

  const handlePurchase = async () => {
    if (!createCheckout) {
      console.error('Checkout action not available')
      alert('Purchase feature is not available at the moment.')
      return
    }

    setPurchasing(true)
    try {
      const { checkoutUrl } = await createCheckout({
        packageKey: selectedPackageKey,
      })

      // Redirect to Polar checkout
      window.location.href = checkoutUrl
    } catch (error) {
      console.error('Error creating checkout:', error)
      alert('Failed to create checkout. Please try again.')
    } finally {
      setPurchasing(false)
    }
  }

  // Don't show token display if user is not authenticated or balance is not loaded
  // The query returns null when user is not authenticated or not found
  if (!tokenBalance) return null

  return (
    <>
      <div className={`flex items-center gap-2 ${className}`}>
        <Coins className="w-4 h-4 text-yellow-500" />
        <span className="text-sm font-medium">{tokenBalance.tokens} tokens</span>
        <button
          onClick={() => setShowPurchaseModal(true)}
          className="text-xs text-blue-600 hover:text-blue-700 underline py-2.5 -my-2.5 px-1 -mx-1"
          data-token-buy-more
        >
          Buy more
        </button>
      </div>

      {showPurchaseModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-semibold text-white mb-4">Purchase Tokens</h2>

            <div className="space-y-4">
              <div className="bg-white/5 border border-white/10 p-4 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium text-white/90">Current Balance</span>
                  <span className="text-lg font-bold text-white">
                    {tokenBalance.tokens} tokens
                  </span>
                </div>
                <div className="text-sm text-white/60">
                  Lifetime used: {tokenBalance.lifetimeUsed} tokens
                </div>
              </div>

              <div className="space-y-3">
                {tokenPackages?.map((tokenPackage) => (
                  <button
                    key={tokenPackage.id}
                    onClick={() => setSelectedPackageKey(tokenPackage.id)}
                    className={`w-full border-2 rounded-lg p-4 transition-all ${
                      selectedPackageKey === tokenPackage.id
                        ? 'border-blue-500 bg-blue-500/20'
                        : 'border-white/20 bg-white/5 hover:border-white/40'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <div className="text-left">
                        <h3 className="font-semibold text-white">{tokenPackage.name}</h3>
                        {tokenPackage.id === '125_tokens' && (
                          <p className="text-sm text-green-400 font-medium">Best Value</p>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-bold text-blue-400">
                          {new Intl.NumberFormat(undefined, {
                            style: 'currency',
                            currency: tokenPackage.currency,
                          }).format(tokenPackage.price / 100)}
                        </div>
                        <div className="text-xs text-white/60">
                          {new Intl.NumberFormat(undefined, {
                            style: 'currency',
                            currency: tokenPackage.currency,
                          }).format(tokenPackage.pricePerToken)}{' '}
                          per token
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
                {!tokenPackages && (
                  <div className="flex justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowPurchaseModal(false)}
                  className="flex-1 px-4 py-2 border border-white/20 text-white/70 hover:text-white hover:border-white/30 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePurchase}
                  disabled={purchasing || !tokenPackages}
                  className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                >
                  {purchasing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    'Purchase'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
