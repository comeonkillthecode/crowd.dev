import { ICache } from '@crowd/types'
import { Logger, LoggerBase } from '@crowd/logging'
import { RedisClient } from './types'

export class RedisCache extends LoggerBase implements ICache {
  private readonly prefixer: (key: string) => string

  private readonly prefixRegex: RegExp

  private readonly directory: string

  constructor(
    public readonly name: string,
    private readonly client: RedisClient,
    parentLog: Logger,
  ) {
    super(parentLog, { cacheName: name })

    this.directory = `cache_${name}`
    this.prefixRegex = new RegExp(`^${this.directory}:`)

    this.prefixer = (key: string) => `${this.directory}:${key}`
  }

  public getDirectory(): string {
    return this.directory
  }

  async get(key: string): Promise<string> {
    const actualKey = this.prefixer(key)
    const value = await this.client.get(actualKey)
    return value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const actualKey = this.prefixer(key)

    if (ttlSeconds !== undefined) {
      await this.client.setEx(actualKey, ttlSeconds, value)
    } else {
      await this.client.set(actualKey, value)
    }
  }

  public setIfNotExistsAlready(key: string, value: string): Promise<boolean> {
    const actualKey = this.prefixer(key)
    return this.client.setNX(actualKey, value)
  }

  public async delete(key: string): Promise<number> {
    const actualKey = this.prefixer(key)
    return this.client.del(actualKey)
  }

  private async deleteByPattern(pattern: string): Promise<number> {
    const script = `
local delpattern = ARGV[1]
local limit = 5000
local count = 0
local valuelist = redis.call('keys', delpattern)
if valuelist then
  if #valuelist ~= 0 then
    for i=1,#valuelist,limit do
      local tempCount = redis.call('del', unpack(valuelist, i, math.min(i+limit-1, #valuelist)))
      count = count + tempCount
    end
  end
end
return count`

    const result = await this.client.eval(script, {
      arguments: [pattern],
    })

    return result as number
  }

  public deleteByKeyPattern(keyPattern: string): Promise<number> {
    const actualPattern = this.prefixer(keyPattern)
    return this.deleteByPattern(actualPattern)
  }

  public deleteAll(): Promise<number> {
    return this.deleteByPattern(this.prefixer('*'))
  }

  public async getKeys(pattern: string, removeCacheName = true): Promise<string[]> {
    const actualPattern = this.prefixer(pattern)
    const keys = await this.client.keys(actualPattern)

    if (removeCacheName) {
      return keys.map((k) => k.replace(this.prefixRegex, ''))
    }

    return keys
  }

  public getAllValues(): Promise<Map<string, string>> {
    return this.getValueByKeyPattern('*')
  }

  public async getValueByKeyPattern(
    keyPattern: string,
    removeCacheName = true,
  ): Promise<Map<string, string>> {
    const actualPattern = this.prefixer(keyPattern)
    const script = `
local keypattern = ARGV[1]
local limit = 5000

local valuelist = redis.call('keys', keypattern)
local results = {}

results['keys'] = {}
results['values'] = {}

local values = results['values']

if valuelist then
  if #valuelist ~= 0 then
    results['keys'] = valuelist
    for i=1,#valuelist,limit do
      local tmp = redis.call('mget', unpack(valuelist, i, math.min(i+limit-1, #valuelist)))
      for j=1, #tmp do
        values[#values+1] = tmp[j]
      end
    end
  end
end
return cjson.encode(results)`

    const results = await this.client.eval(script, {
      arguments: [actualPattern],
    })

    const json: { keys: string[]; values: string[] } = JSON.parse(results as string)
    const map = new Map<string, string>()
    if (json.keys !== undefined && Array.isArray(json.keys)) {
      json.keys.forEach((key, index) => {
        if (removeCacheName) {
          map.set(key.replace(this.prefixRegex, ''), json.values[index])
        } else {
          map.set(key, json.values[index])
        }
      })
    }

    return map
  }
}