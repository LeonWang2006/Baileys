// @ts-ignore - pino 可能需要 esModuleInterop
import P from 'pino'
import type { Logger } from 'pino'

/**
 * Redis 客户端配置接口
 */
export interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
  retryStrategy?: (times: number) => number | null
  maxRetries?: number
  connectTimeout?: number
}

/**
 * Redis 客户端包装类
 * 提供连接、关闭、写入、读取、删除 key 等常用操作
 */
export class RedisClient {
  private logger: Logger
  private client: any
  private config: RedisConfig
  private isConnected: boolean = false
  private retryCount: number = 0
  private maxRetries: number

  constructor(config: RedisConfig, logger?: Logger) {
    const defaults = {
      host: 'localhost',
      port: 6379,
      db: 0,
      connectTimeout: 5000
    }
    this.config = { ...defaults, ...config }
    this.maxRetries = config.maxRetries || 3
    this.logger = logger || P({
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true }
      }
    })
  }

  /**
   * 连接到 Redis
   */
  async connect(): Promise<void> {
    try {
      // 动态导入 redis 包
      // @ts-ignore - redis 是可选依赖
      const redis = await import('redis')

      this.logger.info(
        { host: this.config.host, port: this.config.port },
        '正在连接到 Redis...'
      )

      // 创建客户端连接
      this.client = redis.createClient({
        password: this.config.password,
        socket: {
          host: this.config.host,
          port: this.config.port,
          connectTimeout: this.config.connectTimeout,
          reconnectStrategy: (retries: number) => {
            if (retries > this.maxRetries) {
              this.logger.error(
                { retries },
                'Redis 连接重试次数超过限制，放弃连接'
              )
              return new Error('Redis 连接失败：超过最大重试次数')
            }

            const delay = Math.min(retries * 50, 500)
            this.logger.warn(
              { retries, delay },
              `Redis 连接失败，${delay}ms 后进行第 ${retries} 次重试...`
            )
            return delay
          }
        },
        database: this.config.db
      })

      // 监听错误事件
      this.client.on('error', (err: Error) => {
        this.logger.error({ err }, 'Redis 客户端错误')
        this.isConnected = false
      })

      // 监听连接事件
      this.client.on('connect', () => {
        this.logger.info('Redis 客户端已连接')
        this.isConnected = true
        this.retryCount = 0
      })

      // 监听重新连接事件
      this.client.on('reconnecting', () => {
        this.logger.warn('正在重新连接到 Redis...')
      })

      // 执行连接
      await this.client.connect()
      this.isConnected = true
      this.logger.info('Redis 连接成功')
    } catch (error: any) {
      this.isConnected = false
      this.logger.error(
        { error: error?.message, stack: error?.stack },
        'Redis 连接失败'
      )
      throw new Error(`Redis 连接失败: ${error?.message}`)
    }
  }

  /**
   * 关闭 Redis 连接
   */
  async disconnect(): Promise<void> {
    try {
      if (this.client && this.isConnected) {
        this.logger.info('正在关闭 Redis 连接...')
        await this.client.quit()
        this.isConnected = false
        this.logger.info('Redis 连接已关闭')
      }
    } catch (error: any) {
      this.logger.error(
        { error: error?.message },
        '关闭 Redis 连接时出错'
      )
      throw error
    }
  }

  /**
   * 检查连接状态
   */
  isReady(): boolean {
    return this.isConnected && this.client !== undefined
  }

  /**
   * 设置 key-value 对
   * @param key Redis key
   * @param value 值（自动序列化）
   * @param expiresIn 过期时间（秒），可选
   */
  async set(key: string, value: any, expiresIn?: number): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)

      if (expiresIn) {
        await this.client.setEx(key, expiresIn, stringValue)
        this.logger.debug(
          { key, expiresIn },
          `已将 key "${key}" 设置为值，过期时间为 ${expiresIn} 秒`
        )
      } else {
        await this.client.set(key, stringValue)
        this.logger.debug({ key }, `已将 key "${key}" 设置为值`)
      }
    } catch (error: any) {
      this.logger.error(
        { key, error: error?.message },
        `设置 key "${key}" 失败`
      )
      throw error
    }
  }

  /**
   * 获取 key 对应的值
   * @param key Redis key
   * @returns 值（如果是 JSON，自动反序列化）
   */
  async get(key: string): Promise<any> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const value = await this.client.get(key)

      if (value === null) {
        this.logger.debug({ key }, `key "${key}" 不存在`)
        return null
      }

      // 尝试解析 JSON
      try {
        const parsed = JSON.parse(value)
        this.logger.debug({ key }, `已读取 key "${key}" 的值`)
        return parsed
      } catch {
        // 如果不是有效的 JSON，直接返回字符串
        this.logger.debug({ key }, `已读取 key "${key}" 的值`)
        return value
      }
    } catch (error: any) {
      this.logger.error(
        { key, error: error?.message },
        `读取 key "${key}" 失败`
      )
      throw error
    }
  }

  /**
   * 删除指定的 key
   * @param keys 要删除的 key 或 key 数组
   * @returns 删除的 key 数量
   */
  async delete(keys: string | string[]): Promise<number> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const keyArray = Array.isArray(keys) ? keys : [keys]

      if (keyArray.length === 0) {
        return 0
      }

      const deletedCount = await this.client.del(keyArray)
      this.logger.debug(
        { keys: keyArray, deletedCount },
        `已删除 ${deletedCount} 个 key`
      )
      return deletedCount
    } catch (error: any) {
      this.logger.error(
        { keys, error: error?.message },
        '删除 key 失败'
      )
      throw error
    }
  }

  /**
   * 检查 key 是否存在
   * @param key Redis key
   * @returns 是否存在
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const exists = await this.client.exists(key)
      this.logger.debug({ key, exists: exists === 1 }, `检查 key "${key}" 是否存在`)
      return exists === 1
    } catch (error: any) {
      this.logger.error(
        { key, error: error?.message },
        `检查 key "${key}" 是否存在失败`
      )
      throw error
    }
  }

  /**
   * 获取 key 的剩余过期时间（秒）
   * @param key Redis key
   * @returns 剩余过期时间（秒），-1 表示永不过期，-2 表示 key 不存在
   */
  async ttl(key: string): Promise<number> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const ttlValue = await this.client.ttl(key)
      this.logger.debug({ key, ttl: ttlValue }, `获取 key "${key}" 的过期时间`)
      return ttlValue
    } catch (error: any) {
      this.logger.error(
        { key, error: error?.message },
        `获取 key "${key}" 的过期时间失败`
      )
      throw error
    }
  }

  /**
   * 设置 key 的过期时间
   * @param key Redis key
   * @param seconds 过期时间（秒）
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const result = await this.client.expire(key, seconds)
      this.logger.debug(
        { key, seconds, result },
        `已为 key "${key}" 设置过期时间 ${seconds} 秒`
      )
      return result === 1
    } catch (error: any) {
      this.logger.error(
        { key, seconds, error: error?.message },
        `设置 key "${key}" 的过期时间失败`
      )
      throw error
    }
  }

  /**
   * 清空所有数据库
   */
  async flushAll(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      await this.client.flushAll()
      this.logger.warn('已清空所有 Redis 数据库')
    } catch (error: any) {
      this.logger.error(
        { error: error?.message },
        '清空 Redis 数据库失败'
      )
      throw error
    }
  }

  /**
   * 清空当前数据库
   */
  async flushDb(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      await this.client.flushDb()
      this.logger.warn('已清空当前 Redis 数据库')
    } catch (error: any) {
      this.logger.error(
        { error: error?.message },
        '清空当前 Redis 数据库失败'
      )
      throw error
    }
  }

  /**
   * 获取所有 key 的列表
   * @param pattern key 模式，默认为 '*'
   */
  async keys(pattern: string = '*'): Promise<string[]> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const keys = await this.client.keys(pattern)
      this.logger.debug({ pattern, count: keys.length }, `获取匹配 "${pattern}" 的 keys`)
      return keys
    } catch (error: any) {
      this.logger.error(
        { pattern, error: error?.message },
        '获取 keys 失败'
      )
      throw error
    }
  }

  /**
   * 批量设置 key-value 对
   * @param data 要设置的数据对象
   */
  async mset(data: Record<string, any>): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const entries = Object.entries(data).flatMap(([key, value]) => {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
        return [key, stringValue]
      })

      await this.client.mSet(entries)
      this.logger.debug({ count: Object.keys(data).length }, `已批量设置 ${Object.keys(data).length} 个 key`)
    } catch (error: any) {
      this.logger.error(
        { error: error?.message },
        '批量设置 key 失败'
      )
      throw error
    }
  }

  /**
   * 批量读取 key 的值
   * @param keys 要读取的 key 数组
   */
  async mget(keys: string[]): Promise<(any | null)[]> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const values = await this.client.mGet(keys)
      this.logger.debug({ count: keys.length }, `已批量读取 ${keys.length} 个 key`)

      // 尝试解析 JSON
      return values.map((value: any) => {
        if (value === null) return null
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      })
    } catch (error: any) {
      this.logger.error(
        { error: error?.message },
        '批量读取 key 失败'
      )
      throw error
    }
  }

  /**
   * 递增数值
   * @param key Redis key
   * @param increment 递增数值，默认为 1
   */
  async incr(key: string, increment: number = 1): Promise<number> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const result = await this.client.incrBy(key, increment)
      this.logger.debug({ key, increment, result }, `已将 key "${key}" 递增 ${increment}`)
      return result
    } catch (error: any) {
      this.logger.error(
        { key, increment, error: error?.message },
        `递增 key "${key}" 失败`
      )
      throw error
    }
  }

  /**
   * 递减数值
   * @param key Redis key
   * @param decrement 递减数值，默认为 1
   */
  async decr(key: string, decrement: number = 1): Promise<number> {
    if (!this.isReady()) {
      throw new Error('Redis 客户端未连接')
    }

    try {
      const result = await this.client.decrBy(key, decrement)
      this.logger.debug({ key, decrement, result }, `已将 key "${key}" 递减 ${decrement}`)
      return result
    } catch (error: any) {
      this.logger.error(
        { key, decrement, error: error?.message },
        `递减 key "${key}" 失败`
      )
      throw error
    }
  }

  /**
   * 获取 logger 实例
   */
  getLogger(): Logger {
    return this.logger
  }
}

/**
 * 创建并返回 Redis 客户端实例
 */
export const createRedisClient = (config: RedisConfig, logger?: Logger): RedisClient => {
  return new RedisClient(config, logger)
}

export default RedisClient
