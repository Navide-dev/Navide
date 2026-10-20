<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{ totalStages: number }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animId = 0
let _resizeFn: (() => void) | null = null

// ── Fireworks engine ──────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number
  vx: number; vy: number
  alpha: number; decay: number
  r: number; g: number; b: number
  size: number
}

const PALETTES = [
  [255, 0, 68],   // red
  [255, 140, 0],  // orange
  [255, 220, 0],  // yellow
  [0, 220, 80],   // green
  [0, 160, 255],  // blue
  [200, 60, 255], // purple
  [255, 60, 180], // pink
  [60, 255, 220], // cyan
]

function burst(canvas: HTMLCanvasElement): Particle[] {
  const cx = 0.1 * canvas.width + Math.random() * canvas.width * 0.8
  const cy = 0.1 * canvas.height + Math.random() * canvas.height * 0.55
  const [r, g, b] = PALETTES[Math.floor(Math.random() * PALETTES.length)]
  const count = 55 + Math.floor(Math.random() * 30)
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2
    const spd = 1.5 + Math.random() * 6
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      alpha: 1,
      decay: 0.008 + Math.random() * 0.012,
      r, g, b,
      size: 1.5 + Math.random() * 3,
    }
  })
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const isLight = document.documentElement.dataset.theme === 'light'
  const trailFill = isLight ? 'rgba(240, 245, 255, 0.26)' : 'rgba(10, 10, 20, 0.18)'

  _resizeFn = () => {
    canvas!.width = window.innerWidth
    canvas!.height = window.innerHeight
  }
  _resizeFn()
  window.addEventListener('resize', _resizeFn)

  let particles: Particle[] = []
  let lastBurst = -999

  // Immediately fire 3 simultaneous bursts for a dramatic opening
  for (let i = 0; i < 3; i++) particles.push(...burst(canvas))

  function tick(t: number) {
    // Semi-transparent fill for trail effect
    ctx.fillStyle = trailFill
    ctx.fillRect(0, 0, canvas!.width, canvas!.height)

    // New burst every ~700 ms
    if (t - lastBurst > 700) {
      particles.push(...burst(canvas!))
      lastBurst = t
    }

    // Update & draw each particle
    const alive: Particle[] = []
    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.06    // gravity
      p.vx *= 0.985   // air drag
      p.alpha -= p.decay
      if (p.alpha <= 0) continue
      alive.push(p)

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`
      ctx.globalAlpha = p.alpha
      ctx.fill()
    }
    ctx.globalAlpha = 1
    particles = alive

    animId = requestAnimationFrame(tick)
  }

  animId = requestAnimationFrame(tick)
})

onUnmounted(() => {
  cancelAnimationFrame(animId)
  if (_resizeFn) { window.removeEventListener('resize', _resizeFn); _resizeFn = null }
})
</script>

<template>
  <Teleport to="body">
    <div class="comp-overlay nv-modal-overlay" @click.self="emit('close')">
      <canvas ref="canvasRef" class="comp-canvas" />

      <div class="comp-card nv-modal-shell nv-modal-shell--compact">
        <div class="comp-emoji">🎉</div>
        <h1 class="comp-title">{{ $t('label.pipeline-completed-modal') }}</h1>
        <p class="comp-sub">{{ $t('label.all-stages-finished', { count: totalStages }) }}</p>
        <p class="comp-sub2">{{ $t('hint.completion-modal-body') }}</p>
        <button class="comp-btn nv-btn" @click="emit('close')">{{ $t('action.completion-close') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.comp-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 151);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-app-region: no-drag;
}

:root[data-theme='light'] .comp-overlay {
  background: rgba(210, 225, 255, 0.5);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}

.comp-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.comp-card {
  position: relative;
  z-index: 1;
  background: linear-gradient(145deg, #1a1f2e, var(--bg-base));
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-lg);
  padding: 48px 56px;
  text-align: center;
  box-shadow: var(--shadow-modal);
  max-width: var(--modal-w-compact);
  width: min(var(--modal-w-compact), 92vw);
  animation: pop-in var(--motion-base) var(--ease-out) forwards;
}

:root[data-theme='light'] .comp-card {
  background: linear-gradient(145deg, #ffffff 0%, #f5f0ff 55%, #fff9e8 100%);
  border: 1.5px solid rgba(130, 80, 220, 0.22);
  box-shadow:
    0 0 0 5px rgba(255, 215, 0, 0.07),
    0 0 60px rgba(130, 80, 220, 0.13),
    0 24px 60px rgba(31, 35, 40, 0.1);
}

@keyframes pop-in {
  from { transform: scale(0.6) translateY(20px); opacity: 0; }
  to   { transform: scale(1)   translateY(0);    opacity: 1; }
}

.comp-emoji {
  font-size: 72px;
  line-height: 1;
  margin-bottom: 16px;
  animation: bounce 1s ease-in-out infinite alternate;
}

@keyframes bounce {
  from { transform: translateY(0)    rotate(-5deg); }
  to   { transform: translateY(-10px) rotate(5deg); }
}

.comp-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-on-emphasis);
  margin: 0 0 10px;
  letter-spacing: 0.01em;
  background: linear-gradient(90deg, #ffd700, #ff6b6b, var(--done-emphasis), #06b6d4);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.comp-sub {
  font-size: 15px;
  color: rgba(255,255,255,0.75);
  margin: 0 0 6px;
}

.comp-sub2 {
  font-size: var(--font-sm);
  color: rgba(255,255,255,0.45);
  margin: 0 0 28px;
}

:root[data-theme='light'] .comp-sub {
  color: var(--text-primary);
}

:root[data-theme='light'] .comp-sub2 {
  color: var(--text-secondary);
}

.comp-btn {
  background: linear-gradient(90deg, #ffd700, #ff6b6b);
  color: #000;
  font-weight: 700;
  font-size: 15px;
  border: none;
  border-radius: 10px;
  padding: 12px 32px;
  cursor: pointer;
  transition:
    transform var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
  letter-spacing: 0.02em;
}

.comp-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(255, 215, 0, 0.4);
}

.comp-btn:active {
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .comp-card,
  .comp-emoji {
    animation: none;
  }
}
</style>
