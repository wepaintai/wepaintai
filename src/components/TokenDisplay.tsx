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
  const [selectedProduct, setSelectedProduct] = useState<'50' | '125'>('125')
  
  // Always call hooks in the same order - this is a React requirement
  const tokenBalance = useQuery(api.tokens.getTokenBalance)
  const createCheckout = useAction(api.polar.createCheckout)
  
  const handlePurchase = async () => {
    if (!createCheckout) {
      console.error('Checkout action not available')
      alert('Purchase feature is not available at the moment.')
      return
    }
    
    setPurchasing(true)
    try {
      const productConfig = selectedProduct === '50' 
        ? { 
            productId: import.meta.env.VITE_POLAR_PRODUCT_ID_50,
            tokens: 50 
          }
        : { 
            productId: import.meta.env.VITE_POLAR_PRODUCT_ID_125,
            tokens: 125 
          }
      
      if (!productConfig.productId) {
        alert(`Product ID for ${selectedProduct} token pack not configured. Please contact support.`)
        return
      }
      
      const { checkoutUrl } = await createCheckout({
        productId: productConfig.productId,
        tokens: productConfig.tokens,
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
              
              <div className="space-y-3">
                <button
                  onClick={() => setSelectedProduct('50')}
                  className={`w-full border-2 rounded-lg p-4 transition-all ${
                    selectedProduct === '50' 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-gray-300 bg-white hover:border-gray-400'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <div className="text-left">
                      <h3 className="font-semibold">50 Token Pack</h3>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-blue-600">$4.99</div>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => setSelectedProduct('125')}
                  className={`w-full border-2 rounded-lg p-4 transition-all ${
                    selectedProduct === '125' 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-gray-300 bg-white hover:border-gray-400'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <div className="text-left">
                      <h3 className="font-semibold">125 Token Pack</h3>
                      <p className="text-sm text-green-600 font-medium">Best Value</p>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-blue-600">$9.99</div>
                    </div>
                  </div>
                </button>
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