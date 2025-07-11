import { internalMutation } from "../_generated/server";

export const addInitialTokensToUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all users
    const users = await ctx.db.query("users").collect();
    
    let updatedCount = 0;
    
    for (const user of users) {
      // Only update users who don't have tokens set
      if (user.tokens === undefined || user.tokens === null) {
        await ctx.db.patch(user._id, {
          tokens: 10,
          lifetimeTokensUsed: 0,
          updatedAt: Date.now(),
        });
        
        // Create initial token transaction
        await ctx.db.insert("tokenTransactions", {
          userId: user._id,
          type: "initial",
          amount: 10,
          balance: 10,
          description: "Welcome bonus - 10 free tokens (retroactive)",
          createdAt: Date.now(),
        });
        
        updatedCount++;
      }
    }
    
    console.log(`Migration: Added initial tokens to ${updatedCount} users`);
    return { updatedCount };
  },
});