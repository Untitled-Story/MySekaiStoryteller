import { useState, useCallback } from 'react'

export function useSpinOnce() {
  const [spinning, setSpinning] = useState(false)

  const spin = useCallback(async (callable: () => Promise<any>) => {
    setSpinning(true)
    try {
      await callable()
    } finally {
      setTimeout(() => setSpinning(false), 600)
    }
  }, [])

  return { spinning, spin }
}
