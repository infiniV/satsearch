import { Toaster } from 'sonner'
import { AppShell } from './AppShell'

export default function App(): React.JSX.Element {
  return (
    <>
      <Toaster position="top-right" theme="dark" />
      <AppShell />
    </>
  )
}
