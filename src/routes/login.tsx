import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '@clerk/tanstack-start'

export const Route = createFileRoute('/login')({
  component: LoginComponent,
})

function LoginComponent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <SignIn
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "shadow-xl"
          }
        }}
        routing="path"
        path="/login"
        signUpUrl="/sign-up"
        redirectUrl="/"
      />
    </div>
  )
}