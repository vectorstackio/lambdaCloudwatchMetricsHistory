// handler.ts

import { getRunningInstances, fetchHistory } from './lib'

export const handler = async () => {
  try {
    const instances = await getRunningInstances()

    const hosts = instances.map(instance => ({
      ...instance,
      host: `ip-${instance.privateIp.replace(/\./g, '-')}`
    }))

    const history = await fetchHistory(hosts)

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        period: '24h',
        instances: history
      })
    }
  } catch (error) {
    console.error(error)

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch history'
      })
    }
  }
}