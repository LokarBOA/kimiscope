import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AsyncErrorSurface, ErrorSurface } from './components/ErrorSurface.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorSurface>
      <App />
      <AsyncErrorSurface />
    </ErrorSurface>
  </StrictMode>,
)
