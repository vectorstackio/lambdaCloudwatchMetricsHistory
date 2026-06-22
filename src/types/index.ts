// types/index.ts

export type HistoryPoint = {
  timestamp: string
  value: number
}

export type InstanceHistory = {
  instanceId: string
  name: string
  host: string
  cpu: HistoryPoint[]
  memory: HistoryPoint[]
  disk: HistoryPoint[]
}

export type InstanceInfo = {
  instanceId: string
  privateIp: string
  name: string
  instanceType: string
}

export type TimeRange = {
  startTime: Date
  period: number
}