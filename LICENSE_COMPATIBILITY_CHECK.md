# License Compatibility Check for wepaintai

This document analyzes the license compatibility of all dependencies with the MIT license.

## Summary

Most dependencies are compatible with the MIT license. However, there are a few licenses that require attention:

### ⚠️ Licenses Requiring Attribution or Special Consideration:

1. **MPL-2.0 (Mozilla Public License 2.0)**
   - `@vercel/analytics` - MPL-2.0
   - MPL-2.0 is a weak copyleft license that is generally compatible with MIT
   - You can use and distribute it, but modifications to the MPL-licensed code itself must remain under MPL
   - This doesn't affect your overall project license

2. **Apache-2.0**
   - `@convex-dev/auth` - Apache-2.0
   - `convex` - Apache-2.0
   - `convex-helpers` - Apache-2.0
   - `@polar-sh/nextjs` - Apache-2.0
   - `@polar-sh/sdk` - Apache-2.0
   - Apache-2.0 is compatible with MIT but requires attribution notices to be preserved

3. **ISC**
   - `lucide-react` - ISC
   - ISC is essentially equivalent to MIT and fully compatible

## Full Dependency License List

| Package | License | Compatibility |
|---------|---------|---------------|
| @clerk/clerk-react | MIT | ✅ Compatible |
| @clerk/tanstack-start | MIT | ✅ Compatible |
| @convex-dev/auth | Apache-2.0 | ✅ Compatible (requires attribution) |
| @polar-sh/nextjs | Apache-2.0 | ✅ Compatible (requires attribution) |
| @polar-sh/sdk | Apache-2.0 | ✅ Compatible (requires attribution) |
| @tailwindcss/forms | MIT | ✅ Compatible |
| @tailwindcss/postcss | MIT | ✅ Compatible |
| @tailwindcss/vite | MIT | ✅ Compatible |
| @tanstack/react-router | MIT | ✅ Compatible |
| @tanstack/react-start | MIT | ✅ Compatible |
| @vercel/analytics | MPL-2.0 | ✅ Compatible (weak copyleft) |
| autoprefixer | MIT | ✅ Compatible |
| clsx | MIT | ✅ Compatible |
| convex | Apache-2.0 | ✅ Compatible (requires attribution) |
| convex-helpers | Apache-2.0 | ✅ Compatible (requires attribution) |
| framer-motion | MIT | ✅ Compatible |
| konva | MIT | ✅ Compatible |
| lucide-react | ISC | ✅ Compatible |
| perfect-freehand | MIT | ✅ Compatible |
| postcss | MIT | ✅ Compatible |
| react | MIT | ✅ Compatible |
| react-dom | MIT | ✅ Compatible |
| react-konva | MIT | ✅ Compatible |
| tailwind-merge | MIT | ✅ Compatible |
| tailwindcss | MIT | ✅ Compatible |
| vinxi | MIT | ✅ Compatible |
| zod | MIT | ✅ Compatible |

## Recommendations

1. **No GPL or AGPL dependencies found** - Your project is safe from strong copyleft licenses that would be incompatible with MIT.

2. **For Apache-2.0 dependencies** (@convex-dev/auth, convex, convex-helpers, @polar-sh/*):
   - Include their copyright notices and license text in your distribution
   - This is typically handled automatically when distributing via npm

3. **For MPL-2.0 dependency** (@vercel/analytics):
   - You can use it freely in your MIT-licensed project
   - If you modify the @vercel/analytics code itself, those modifications must be released under MPL-2.0
   - Your overall project can remain MIT licensed

4. **Best Practice**: Include a NOTICE file or update your LICENSE file to acknowledge the Apache-2.0 licensed dependencies, especially if you're distributing compiled/bundled code.

## Conclusion

All dependencies are compatible with the MIT license. The project can safely use the MIT license without any licensing conflicts.