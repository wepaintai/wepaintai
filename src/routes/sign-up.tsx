import { createFileRoute } from '@tanstack/react-router'
import { SignUp } from '@clerk/tanstack-start'

export const Route = createFileRoute('/sign-up')({
  component: SignUpComponent,
})

function SignUpComponent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <SignUp
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "shadow-xl"
          }
        }}
        routing="path"
        path="/sign-up"
        signInUrl="/login"
        redirectUrl="/"
      />
    </div>
  )
}