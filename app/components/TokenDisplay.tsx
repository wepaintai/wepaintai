import React, { useState } from 'react'
import { useQuery, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Coins, Loader2 } from 'lucide-react'
import { useAuth } from '@clerk/tanstack-start'

interface TokenDisplayProps {
  className?: string
}

export function TokenDisplay({ className = '' }: TokenDisplayProps) {
  const { userId } = useAuth()
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  
  const tokenBalance = useQuery(api.tokens.getTokenBalance)
  const createCheckout = useAction(api.polar.createCheckout)
  
  const handlePurchase = async () => {
    setPurchasing(true)
    try {
      const { checkoutUrl } = await createCheckout({
        productId: import.meta.env.VITE_POLAR_PRODUCT_ID || 'prod_100_tokens',
        tokens: 100,
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
  if (!userId || tokenBalance === undefined) return null
  
  // Also hide if tokenBalance is null (user not found in database)
  if (tokenBalance === null) return null
  
  return (
    <>
      <div className={`flex items-center gap-2 ${className}`}>
        <Coins className="w-4 h-4 text-yellow-500" />
        <span className="text-sm font-medium">
          {tokenBalance.tokens} tokens
        </span>
        <button
          onClick={() => setShowPurchaseModal(true)}
          className="text-xs text-blue-500 hover:text-blue-600 underline"
          data-token-buy-more
        >
          Buy more
        </button>
      </div>
      
      {showPurchaseModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-4">Purchase Tokens</h2>
            
            <div className="space-y-4">
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium">Current Balance</span>
                  <span className="text-lg font-bold text-gray-700">
                    {tokenBalance.tokens} tokens
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  Lifetime used: {tokenBalance.lifetimeUsed} tokens
                </div>
              </div>
              
              <div className="border-2 border-blue-500 rounded-lg p-4 bg-blue-50">
                <div className="flex justify-between items-center mb-2">
                  <div>
                    <h3 className="font-semibold">100 Token Pack</h3>
                    <p className="text-sm text-gray-600">
                      Generate up to 100 AI images
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-blue-600">$9.99</div>
                    <div className="text-xs text-gray-600">$0.10 per image</div>
                  </div>
                </div>
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setShowPurchaseModal(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePurchase}
                  disabled={purchasing}
                  className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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