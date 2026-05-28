import { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const MODES = {
  listen: { color: new THREE.Color('#5dcca5'), amp: 0.35 },
  think:  { color: new THREE.Color('#378add'), amp: 0.5 },
  speak:  { color: new THREE.Color('#9d7bea'), amp: 0.85 },
}

function Particles({ mode = 'listen', count = 3000 }) {
  const ref = useRef()
  const matRef = useRef()
  const curColor = useRef(MODES.listen.color.clone())
  const curAmp = useRef(0.35)

  const basePositions = useMemo(() => {
    const pos = new Float32Array(count * 3)
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2
      const r = Math.sqrt(1 - y * y)
      const theta = golden * i
      pos[i * 3] = Math.cos(theta) * r
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = Math.sin(theta) * r
    }
    return pos
  }, [count])

  const positions = useMemo(() => basePositions.slice(), [basePositions])

  useFrame((state, delta) => {
    const target = MODES[mode] || MODES.listen
    const t = state.clock.elapsedTime

    curColor.current.lerp(target.color, 0.05)
    curAmp.current += (target.amp - curAmp.current) * 0.05

    if (matRef.current) matRef.current.color.copy(curColor.current)

    if (ref.current) {
      ref.current.rotation.y += delta * 0.15
      ref.current.rotation.x = Math.sin(t * 0.3) * 0.12

      const breath = 1 + Math.sin(t * 1.6) * 0.04 * (0.4 + curAmp.current)
      const posAttr = ref.current.geometry.attributes.position
      for (let i = 0; i < count; i++) {
        const wob = 1 + Math.sin(t * 3 + i * 0.7) * 0.04 * curAmp.current * 2
        const s = 2 * breath * wob
        posAttr.array[i * 3] = basePositions[i * 3] * s
        posAttr.array[i * 3 + 1] = basePositions[i * 3 + 1] * s
        posAttr.array[i * 3 + 2] = basePositions[i * 3 + 2] * s
      }
      posAttr.needsUpdate = true
    }
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial ref={matRef} size={0.025} color="#5dcca5" transparent opacity={0.9} sizeAttenuation />
    </points>
  )
}

export default function VoiceOrb({ mode = 'listen' }) {
  return (
    <Canvas camera={{ position: [0, 0, 7], fov: 50 }} style={{ width: '100%', height: '100%' }}>
      <Particles mode={mode} />
    </Canvas>
  )
}
