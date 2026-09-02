import { defineStore } from 'pinia'

export const useAppStore = defineStore('app', {
  state: () => ({
    pings: 0
  }),
  actions: {
    ping(): void {
      this.pings += 1
    }
  }
})
