import React, { useState } from 'react'
import { X, Brush, Sliders, RotateCcw } from 'lucide-react'

export interface BrushSettings {
  smoothing: number
  thinning: number
  streamline: number
  startTaper: number
  endTaper: number
}

interface BrushSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  settings: BrushSettings
  onSettingsChange: (settings: BrushSettings) => void
}

const DEFAULT_SETTINGS: BrushSettings = {
  smoothing: 0.5,
  thinning: 0.5,
  streamline: 0.5,
  startTaper: 0,
  endTaper: 0,
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  description?: string
}

const SettingsSlider = ({ label, value, min, max, step, onChange, description }: SliderProps) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-white/80">{label}</label>
        <span className="text-xs text-white/60 tabular-nums">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer slider"
        style={{
          background: `linear-gradient(to right, hsl(220, 60%, 50%) 0%, hsl(220, 60%, 50%) ${((value - min) / (max - min)) * 100}%, rgba(255, 255, 255, 0.2) ${((value - min) / (max - min)) * 100}%, rgba(255, 255, 255, 0.2) 100%)`
        }}
      />
      {description && (
        <p className="text-xs text-white/50">{description}</p>
      )}
    </div>
  )
}

export function BrushSettingsModal({ isOpen, onClose, settings, onSettingsChange }: BrushSettingsModalProps) {
  const [localSettings, setLocalSettings] = useState<BrushSettings>(settings)

  if (!isOpen) return null

  const handleSettingChange = (key: keyof BrushSettings, value: number) => {
    const newSettings = { ...localSettings, [key]: value }
    setLocalSettings(newSettings)
    onSettingsChange(newSettings)
  }

  const handleReset = () => {
    setLocalSettings(DEFAULT_SETTINGS)
    onSettingsChange(DEFAULT_SETTINGS)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-black/90 backdrop-blur-md border border-white/20 rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-white/80" />
            <h2 className="text-lg font-semibold text-white">Brush Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-white/60" />
          </button>
        </div>

        <div className="space-y-6">
          <SettingsSlider
            label="Smoothing"
            value={localSettings.smoothing}
            min={0}
            max={1}
            step={0.05}
            onChange={(value) => handleSettingChange('smoothing', value)}
            description="Controls how smooth the stroke appears. Higher values create smoother lines."
          />

          <SettingsSlider
            label="Thinning"
            value={localSettings.thinning}
            min={-1}
            max={1}
            step={0.05}
            onChange={(value) => handleSettingChange('thinning', value)}
            description="Simulates pressure sensitivity. Positive values thin the stroke with speed."
          />

          <SettingsSlider
            label="Streamline"
            value={localSettings.streamline}
            min={0}
            max={1}
            step={0.05}
            onChange={(value) => handleSettingChange('streamline', value)}
            description="Reduces jitter by filtering input points. Higher values create cleaner lines."
          />

          <SettingsSlider
            label="Start Taper"
            value={localSettings.startTaper}
            min={0}
            max={100}
            step={5}
            onChange={(value) => handleSettingChange('startTaper', value)}
            description="Tapers the beginning of the stroke."
          />

          <SettingsSlider
            label="End Taper"
            value={localSettings.endTaper}
            min={0}
            max={100}
            step={5}
            onChange={(value) => handleSettingChange('endTaper', value)}
            description="Tapers the end of the stroke."
          />
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-sm text-white/60 hover:text-white hover:bg-white/10 rounded transition-colors flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
