import { useCallback, useEffect, useRef, useState } from 'react'
import type { RandomizerResults } from '../../lib/randomizer'
import { useGameData } from '../../lib/GameDataContext'
import type {
  PidSearchRequest,
  SpeciesResultMessage,
  SpeciesSearchRequest,
  WorkerMessage,
  WorkerRequest,
} from './protocol'

let nextRequestId = 1

/** Owns one Web Worker (randomizer.worker.ts) running the reverse search off the main
 * thread -- a real search is tens of millions of candidate generations/verifications.
 * One instance per mounted route (PID Finder / Species Finder each get their own),
 * re-initialized with the already-loaded game data on mount; the worker itself never
 * touches the network. */
export function useRandomizerWorker() {
  const { abilities, species, meta } = useGameData()
  const workerRef = useRef<Worker | null>(null)
  const activeRequestId = useRef<number | null>(null)

  const [ready, setReady] = useState(false)
  const [searching, setSearching] = useState(false)
  const [progress, setProgress] = useState<{ scanned: number; totalToScan: number } | null>(null)
  const [pidResult, setPidResult] = useState<RandomizerResults | null>(null)
  const [speciesResult, setSpeciesResult] = useState<SpeciesResultMessage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const worker = new Worker(new URL('./randomizer.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data
      switch (msg.type) {
        case 'ready':
          setReady(true)
          break
        case 'progress':
          if (msg.requestId === activeRequestId.current) {
            setProgress({ scanned: msg.scanned, totalToScan: msg.totalToScan })
          }
          break
        case 'pidResult':
          if (msg.requestId === activeRequestId.current) {
            setPidResult(msg.results)
            setSearching(false)
          }
          break
        case 'speciesResult':
          if (msg.requestId === activeRequestId.current) {
            setSpeciesResult(msg)
            setSearching(false)
          }
          break
        case 'error':
          if (msg.requestId === undefined || msg.requestId === activeRequestId.current) {
            setError(msg.message)
            setSearching(false)
          }
          break
      }
    }

    const init: WorkerRequest = { type: 'init', abilities, species, abilitiesCount: meta.abilitiesCount }
    worker.postMessage(init)

    return () => worker.terminate()
    // Game data is loaded once for the whole app's lifetime (GameDataProvider) --
    // intentionally not re-sent on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runPidSearch = useCallback((args: Omit<PidSearchRequest, 'type' | 'requestId'>) => {
    const worker = workerRef.current
    if (!worker) return
    const requestId = nextRequestId++
    activeRequestId.current = requestId
    setSearching(true)
    setError(null)
    setProgress(null)
    const req: PidSearchRequest = { type: 'pidSearch', requestId, ...args }
    worker.postMessage(req)
  }, [])

  const runSpeciesSearch = useCallback((args: Omit<SpeciesSearchRequest, 'type' | 'requestId'>) => {
    const worker = workerRef.current
    if (!worker) return
    const requestId = nextRequestId++
    activeRequestId.current = requestId
    setSearching(true)
    setError(null)
    setProgress(null)
    const req: SpeciesSearchRequest = { type: 'speciesSearch', requestId, ...args }
    worker.postMessage(req)
  }, [])

  const cancel = useCallback(() => {
    const worker = workerRef.current
    if (!worker || activeRequestId.current === null) return
    worker.postMessage({ type: 'cancel', requestId: activeRequestId.current })
    setSearching(false)
  }, [])

  return { ready, searching, progress, error, pidResult, speciesResult, runPidSearch, runSpeciesSearch, cancel }
}
