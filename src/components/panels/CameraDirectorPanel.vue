<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  trajectoryInput,
  cameraTrajectory,
  activeKeyframe,
  cameraElapsed,
  isCameraPlaying,
  recordState,
  recordFps,
  recordCodec,
  addWatermark,
  cameraDuration,
  recordingEstimate,
  captureCurrentPose,
  selectKeyframe,
  stepKeyframe,
  applyActivePose,
  deleteActiveKeyframe,
  clearCameraTrajectory,
  setKeyframeTime,
  saveTrajectory,
  openTrajectory,
  loadCinematicDemo,
  toggleCameraPlay,
  stopTrajectory,
  onCameraScrub,
  toggleRecording,
} = studio
</script>

<template>
  <section class="cinema-section">
    <h3>
      相机导演 <span class="count">{{ cameraTrajectory.frames.length }}</span>
    </h3>
    <div class="replay-row">
      <button class="ghost" @click="captureCurrentPose">＋ 记录当前视角</button>
      <button class="ghost" @click="applyActivePose">↩ 回到关键帧</button>
    </div>
    <div class="cam-kf-list">
      <div
        v-for="(kf, i) in cameraTrajectory.frames"
        :key="kf.id"
        class="cam-kf"
        :class="{ active: activeKeyframe === i }"
        @click="selectKeyframe(i)"
      >
        <span class="cam-kf-id">#{{ i + 1 }}</span>
        <span class="cam-kf-meta">转 {{ kf.transition }}s · 停 {{ kf.hold }}s</span>
      </div>
      <div v-if="!cameraTrajectory.frames.length" class="empty">切到 3D 视角，摆好相机后点「记录当前视角」</div>
    </div>
    <div class="replay-row">
      <button class="ghost" :disabled="!cameraTrajectory.frames.length" @click="stepKeyframe(-1)">◀ 上一个</button>
      <button class="ghost" :disabled="!cameraTrajectory.frames.length" @click="stepKeyframe(1)">下一个 ▶</button>
    </div>
    <div class="replay-row" style="margin-top: 6px">
      <label
        >转场<input
          type="number"
          min="0"
          max="60"
          step="0.5"
          :value="cameraTrajectory.frames[activeKeyframe]?.transition ?? 0"
          @input="setKeyframeTime('transition', $event)"
      /></label>
      <label
        >停留<input
          type="number"
          min="0"
          max="60"
          step="0.5"
          :value="cameraTrajectory.frames[activeKeyframe]?.hold ?? 0"
          @input="setKeyframeTime('hold', $event)"
      /></label>
    </div>
    <div class="replay-row" style="margin-top: 6px">
      <button class="ghost" :disabled="!cameraTrajectory.frames.length" @click="deleteActiveKeyframe">删除</button>
      <button class="ghost" :disabled="!cameraTrajectory.frames.length" @click="clearCameraTrajectory">清空</button>
      <button class="ghost" @click="loadCinematicDemo">演示运镜</button>
    </div>
    <div class="cinema-options">
      <label><input v-model="cameraTrajectory.options.spline" type="checkbox" /> 样条</label>
      <label><input v-model="cameraTrajectory.options.smoothVelocity" type="checkbox" /> 缓入缓出</label>
      <label><input v-model="cameraTrajectory.options.allowRoll" type="checkbox" /> 允许 roll</label>
      <label><input v-model="cameraTrajectory.options.loop" type="checkbox" /> 循环</label>
    </div>
    <div class="replay-row">
      <button class="play-btn" @click="toggleCameraPlay">{{ isCameraPlaying ? '⏸ 暂停运镜' : '▶ 播放运镜' }}</button>
      <button class="ghost" @click="stopTrajectory">⏹ 复位</button>
    </div>
    <input
      class="cam-scrub"
      type="range"
      min="0"
      :max="cameraDuration || 1"
      step="0.01"
      :value="cameraElapsed"
      :disabled="cameraDuration === 0"
      @input="onCameraScrub"
    />
    <div class="hint-small">
      {{ cameraElapsed.toFixed(1) }}s / {{ cameraDuration.toFixed(1) }}s · 镜头运动与数据帧回放独立计时
    </div>
    <div class="replay-row" style="margin-top: 8px">
      <button class="ghost" @click="saveTrajectory">保存轨迹 ↓</button>
      <button class="ghost" @click="trajectoryInput?.click()">打开轨迹 ↑</button>
      <input ref="trajectoryInput" type="file" accept=".json" hidden @change="openTrajectory" />
    </div>
    <div class="record-box">
      <div class="record-title">
        <span>视频录制</span>
        <span class="record-state" :class="{ on: recordState !== 'idle' }">
          {{ recordState === 'recording' ? '● 录制中' : recordState === 'finishing' ? '◌ 封装中' : '○ 就绪' }}
        </span>
      </div>
      <div class="replay-row">
        <label
          >fps
          <select v-model.number="recordFps">
            <option :value="15">15</option>
            <option :value="30">30</option>
            <option :value="60">60</option>
          </select>
        </label>
        <label
          >编码
          <select v-model="recordCodec">
            <option value="vp9">VP9</option>
            <option value="vp8">VP8</option>
          </select>
        </label>
      </div>
      <label class="record-watermark"><input v-model="addWatermark" type="checkbox" /> 右下角水印</label>
      <button
        class="record-btn"
        :disabled="cameraTrajectory.frames.length < 2 || recordState === 'finishing'"
        @click="toggleRecording"
      >
        {{ recordState === 'recording' ? '■ 结束录制' : '● 录制视频' }}
      </button>
      <div class="hint-small">
        {{ recordingEstimate }} ·
        {{ recordState === 'recording' ? '再点一次可提前结束' : '播放一圈运镜后自动导出 WebM' }}
      </div>
    </div>
  </section>
</template>
