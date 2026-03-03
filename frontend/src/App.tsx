import './App.css'
import Avatar, { setLipSyncAnalyser, setLipSyncSpeaking } from './components/Avatar'
import { useState, useRef, useEffect } from 'react'

type Status = 'idle' | 'listening' | 'processing' | 'speaking'

const generateSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  // Keep session ID in a ref so async callbacks always see latest value
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    window.speechSynthesis.getVoices()
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioRef.current?.pause()
      window.speechSynthesis.cancel()
      cleanupAudio()
    }
  }, [])

  const cleanupAudio = () => {
    setLipSyncAnalyser(null)
    setLipSyncSpeaking(false)
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }

  // ── Start a brand-new session & begin ONE recording ───────────────────
  const startSession = async () => {
    const newSessionId = generateSessionId()
    sessionIdRef.current = newSessionId
    setSessionId(newSessionId)
    console.log('[Session] Started:', newSessionId)
    await startListening(newSessionId)
  }

  // ── End session completely — user explicitly clicked Stop ─────────────
  const endSession = () => {
    audioRef.current?.pause()
    window.speechSynthesis.cancel()
    cleanupAudio()

    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (recorderRef.current?.state !== 'inactive') {
      recorderRef.current?.stop()
    }

    // Invalidate session so any in-flight async callback won't restart
    sessionIdRef.current = null
    setSessionId(null)
    setStatus('idle')
    console.log('[Session] Ended by user')
  }

  // ── Start recording (called once per conversation turn) ───────────────
  const startListening = async (sid: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(m => MediaRecorder.isTypeSupported(m)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      recorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const total = audioChunksRef.current.reduce((s, b) => s + b.size, 0)
        if (total < 1000) {
          // Not enough audio — only go back to idle, do NOT restart automatically
          setStatus('idle')
          return
        }
        // Send audio; after AI responds, we stop (no auto-loop)
        await sendToBackend(sid)
      }

      recorder.start(1000)
      setStatus('listening')
    } catch (err) {
      console.error('Mic error:', err)
      setStatus('idle')
    }
  }

  // ── User taps the stop-mic button while listening ─────────────────────
  const stopListening = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (recorderRef.current?.state !== 'inactive') {
      recorderRef.current?.stop()
      setStatus('processing')
    } else {
      setStatus('idle')
    }
  }

  // ── Send audio to backend ─────────────────────────────────────────────
  const sendToBackend = async (sid: string) => {
    try {
      const mimeType = recorderRef.current?.mimeType || 'audio/webm'
      const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm'
      const blob = new Blob(audioChunksRef.current, { type: mimeType })
      const formData = new FormData()
      formData.append('audio', blob, `voice.${ext}`)
      formData.append('session_id', sid)

      const res = await fetch('https://voice-ai-avatar.onrender.com/ask', { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`Backend ${res.status}`)
      const data = await res.json()

      if (!data.text) {
        setStatus('idle')
        return
      }
      console.log('[App] reply:', data.text, '| audio_b64 length:', data.audio_b64?.length ?? 0)

      if (data.audio_b64?.length > 100) {
        await playWithRealLipSync(data.audio_b64)
      } else {
        await speakBrowserTTS(data.text)
      }

      // ✅ After AI finishes speaking, go idle — do NOT auto-restart listening.
      // User must click "Talk Again" to have another conversation turn.
      setStatus('idle')

    } catch (err) {
      console.error('Backend failed:', err)
      setStatus('idle')
    }
  }

  // ── Real audio → AudioContext analyser → lip sync ─────────────────────
  const playWithRealLipSync = (b64: string): Promise<void> => {
    return new Promise((resolve) => {
      cleanupAudio()
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }

      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)

      const audio = new Audio()
      audio.crossOrigin = 'anonymous'
      audioRef.current = audio

      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.35
      const source = ctx.createMediaElementSource(audio)
      source.connect(analyser)
      analyser.connect(ctx.destination)
      setLipSyncAnalyser(analyser)

      audio.src = url
      audio.addEventListener('canplaythrough', () => {
        setStatus('speaking')
        setLipSyncSpeaking(true)
        ctx.resume().then(() => audio.play()).catch(e => {
          console.error('[Audio] play error:', e)
          cleanupAudio()
          setStatus('idle')
          resolve()
        })
      }, { once: true })

      audio.onended = () => {
        setLipSyncSpeaking(false)
        setLipSyncAnalyser(null)
        cleanupAudio()
        URL.revokeObjectURL(url)
        setStatus('idle')
        resolve()
      }
      audio.onerror = (e) => {
        console.error('[Audio] error', e)
        cleanupAudio()
        URL.revokeObjectURL(url)
        setStatus('idle')
        resolve()
      }
    })
  }

  // ── Browser TTS fallback ──────────────────────────────────────────────
  const speakBrowserTTS = (text: string): Promise<void> => {
    return new Promise((resolve) => {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      const voices = window.speechSynthesis.getVoices()
      const pick = ['Samantha', 'Karen', 'Victoria', 'Zira', 'Google UK English Female', 'Google US English']
      const voice = pick.reduce<SpeechSynthesisVoice | null>(
        (f, n) => f || voices.find(v => v.name.includes(n)) || null, null
      )
      if (voice) utterance.voice = voice
      utterance.rate = 1.0
      utterance.pitch = 1.05
      utterance.onstart = () => { setStatus('speaking'); setLipSyncSpeaking(true) }
      utterance.onend = () => { setLipSyncSpeaking(false); setStatus('idle'); resolve() }
      utterance.onerror = () => { setLipSyncSpeaking(false); setStatus('idle'); resolve() }
      window.speechSynthesis.speak(utterance)
    })
  }

  // ── Interrupt speaking ────────────────────────────────────────────────
  const interruptSpeaking = () => {
    audioRef.current?.pause()
    window.speechSynthesis.cancel()
    cleanupAudio()
    setStatus('idle')
  }

  const sessionActive = sessionId !== null

  // What to show in the bottom area
  const showTalkAgain = sessionActive && status === 'idle'

  return (
    <div className="fixed inset-0 bg-[#08060f] overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 transition-all duration-700" style={{
        background:
          status === 'listening'  ? 'radial-gradient(ellipse 60% 50% at 50% 85%, rgba(16,185,129,0.14) 0%, transparent 70%)' :
          status === 'speaking'   ? 'radial-gradient(ellipse 60% 50% at 50% 85%, rgba(168,85,247,0.16) 0%, transparent 70%)' :
          status === 'processing' ? 'radial-gradient(ellipse 60% 50% at 50% 85%, rgba(245,158,11,0.12) 0%, transparent 70%)' :
                                    'radial-gradient(ellipse 60% 50% at 50% 85%, rgba(99,102,241,0.07) 0%, transparent 70%)',
      }} />

      <Avatar isSpeaking={status === 'speaking'} isListening={status === 'listening'} />

      {/* Status pill */}
      {sessionActive && status !== 'idle' && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-black/50 backdrop-blur-md border border-white/10 rounded-full px-4 py-1.5">
          <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${
            status === 'listening' ? 'bg-emerald-400' :
            status === 'processing' ? 'bg-amber-400' :
            'bg-violet-400'
          }`} />
          <span className="text-white/70 text-xs tracking-widest uppercase font-medium">
            {status === 'listening' ? 'Listening...' :
             status === 'processing' ? 'Thinking...' :
             'Speaking...'}
          </span>
        </div>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-10 left-0 right-0 flex flex-col items-center gap-3 z-10">

        {/* ── No session: Start button ── */}
        {!sessionActive && (
          <>
            <button
              onClick={startSession}
              className="flex items-center justify-center w-16 h-16 rounded-full text-white transition-all duration-200 hover:scale-110 active:scale-95"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', boxShadow: '0 0 40px rgba(99,102,241,0.6), 0 4px 20px rgba(0,0,0,0.5)' }}>
              <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </button>
            <span className="text-white/25 text-[11px] tracking-widest uppercase">tap to start conversation</span>
          </>
        )}

        {/* ── Active session controls ── */}
        {sessionActive && (
          <div className="flex flex-col items-center gap-3">

            <div className="flex items-center gap-5">

              {/* LISTENING: tap stop to send audio */}
              {status === 'listening' && (
                <button
                  onClick={stopListening}
                  className="relative flex items-center justify-center w-16 h-16 rounded-full text-white transition-all duration-200 hover:scale-110 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #dc2626, #b91c1c)', boxShadow: '0 0 40px rgba(220,38,38,0.6), 0 4px 20px rgba(0,0,0,0.5)' }}>
                  <span className="absolute inset-0 rounded-full border-2 border-red-400/60 animate-ping" />
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              )}

              {/* PROCESSING: spinner */}
              {status === 'processing' && (
                <div
                  className="flex items-center justify-center w-16 h-16 rounded-full"
                  style={{ background: 'linear-gradient(135deg, #92400e, #b45309)', boxShadow: '0 0 40px rgba(245,158,11,0.4)' }}>
                  <svg className="w-7 h-7 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                </div>
              )}

              {/* SPEAKING: tap to interrupt */}
              {status === 'speaking' && (
                <button
                  onClick={interruptSpeaking}
                  className="flex items-center justify-center w-16 h-16 rounded-full text-white transition-all duration-200 hover:scale-110 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', boxShadow: '0 0 40px rgba(168,85,247,0.6), 0 4px 20px rgba(0,0,0,0.5)' }}>
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              )}

              {/* IDLE (session active): Talk Again button */}
              {showTalkAgain && (
                <button
                  onClick={() => startListening(sessionId!)}
                  className="flex items-center justify-center w-16 h-16 rounded-full text-white transition-all duration-200 hover:scale-110 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #059669, #047857)', boxShadow: '0 0 40px rgba(16,185,129,0.5), 0 4px 20px rgba(0,0,0,0.5)' }}>
                  <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                  </svg>
                </button>
              )}

              {/* End Session button — always visible during a session */}
              <button
                onClick={endSession}
                className="flex items-center justify-center w-12 h-12 rounded-full text-white/80 border border-white/20 transition-all duration-200 hover:scale-110 hover:border-red-400/60 hover:text-red-400 active:scale-95"
                style={{ background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(8px)' }}
                title="End conversation">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <span className="text-white/25 text-[11px] tracking-widest uppercase">
              {status === 'listening'  ? 'tap ■ to send' :
               status === 'processing' ? 'please wait...' :
               status === 'speaking'   ? 'tap ■ to interrupt' :
               'tap 🎤 to talk again  ·  ✕ to end session'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}