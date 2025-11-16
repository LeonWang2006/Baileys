/**
 * Redis 客户端使用示例
 * 
 * 使用前需要安装 redis 包：
 * npm install redis
 * 或
 * pnpm add redis
 */

import { createRedisClient, type RedisConfig } from './redis-client.js'
// @ts-ignore - pino 可能需要 esModuleInterop
import P from 'pino'

/**
 * 主函数 - 演示 Redis 客户端的各种操作
 */
async function main() {
  // 创建 logger
  const logger = P({
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  })

  // Redis 连接配置
  const redisConfig: RedisConfig = {
    host: 'localhost',
    port: 6379,
    // password: 'your-password', // 如果需要认证
    db: 0,
    connectTimeout: 5000,
    maxRetries: 3
  }

  // 创建 Redis 客户端
  const redisClient = createRedisClient(redisConfig, logger)

  try {
    // 1. 连接到 Redis
    logger.info('【示例】开始连接到 Redis...')
    await redisClient.connect()
    logger.info('【示例】✓ Redis 连接成功')

    // 2. 设置简单值
    logger.info('\n【示例】设置简单字符串值...')
    await redisClient.set('user:name', 'John Doe')
    logger.info('【示例】✓ 设置成功：user:name = "John Doe"')

    // 3. 读取值
    logger.info('\n【示例】读取 user:name 的值...')
    const userName = await redisClient.get('user:name')
    logger.info(`【示例】✓ 读取成功：${userName}`)

    // 4. 设置带过期时间的值
    logger.info('\n【示例】设置带过期时间的值（30 秒后过期）...')
    await redisClient.set('session:token', 'abc123xyz', 30)
    logger.info('【示例】✓ 设置成功：session:token = "abc123xyz"（过期时间：30 秒）')

    // 5. 获取过期时间
    logger.info('\n【示例】获取 session:token 的剩余过期时间...')
    const ttl = await redisClient.ttl('session:token')
    logger.info(`【示例】✓ 剩余过期时间：${ttl} 秒`)

    // 6. 设置 JSON 对象
    logger.info('\n【示例】设置 JSON 对象...')
    const userObject = {
      id: 123,
      name: 'John Doe',
      email: 'john@example.com',
      age: 30
    }
    await redisClient.set('user:123', userObject)
    logger.info('【示例】✓ 设置成功：user:123 = JSON 对象')

    // 7. 读取 JSON 对象
    logger.info('\n【示例】读取 user:123 的 JSON 对象...')
    const user = await redisClient.get('user:123')
    logger.info(`【示例】✓ 读取成功：${JSON.stringify(user, null, 2)}`)

    // 8. 检查 key 是否存在
    logger.info('\n【示例】检查 user:123 是否存在...')
    const exists = await redisClient.exists('user:123')
    logger.info(`【示例】✓ user:123 存在：${exists}`)

    // 9. 批量设置
    logger.info('\n【示例】批量设置多个 key...')
    await redisClient.mset({
      'counter:page_views': 1000,
      'counter:user_logins': 500,
      'counter:api_calls': 5000
    })
    logger.info('【示例】✓ 批量设置成功')

    // 10. 批量读取
    logger.info('\n【示例】批量读取多个 key...')
    const values = await redisClient.mget([
      'counter:page_views',
      'counter:user_logins',
      'counter:api_calls'
    ])
    logger.info(`【示例】✓ 批量读取成功：${JSON.stringify(values)}`)

    // 11. 数值递增
    logger.info('\n【示例】递增 counter:page_views...')
    const newPageViews = await redisClient.incr('counter:page_views', 100)
    logger.info(`【示例】✓ 递增成功：counter:page_views = ${newPageViews}`)

    // 12. 数值递减
    logger.info('\n【示例】递减 counter:user_logins...')
    const newLogins = await redisClient.decr('counter:user_logins', 10)
    logger.info(`【示例】✓ 递减成功：counter:user_logins = ${newLogins}`)

    // 13. 获取所有 key
    logger.info('\n【示例】获取所有 counter:* 模式的 key...')
    const counterKeys = await redisClient.keys('counter:*')
    logger.info(`【示例】✓ 找到 ${counterKeys.length} 个 key：${JSON.stringify(counterKeys)}`)

    // 14. 删除单个 key
    logger.info('\n【示例】删除 session:token...')
    const deletedCount = await redisClient.delete('session:token')
    logger.info(`【示例】✓ 删除成功：${deletedCount} 个 key 被删除`)

    // 15. 删除多个 key
    logger.info('\n【示例】删除多个 counter:* 的 key...')
    const deletedCounters = await redisClient.delete([
      'counter:page_views',
      'counter:user_logins',
      'counter:api_calls'
    ])
    logger.info(`【示例】✓ 删除成功：${deletedCounters} 个 key 被删除`)

    // 16. 设置已存在 key 的过期时间
    logger.info('\n【示例】为 user:123 设置过期时间（60 秒）...')
    await redisClient.expire('user:123', 60)
    logger.info('【示例】✓ 设置成功')

    logger.info('\n【示例】所有操作完成！')
  } catch (error: any) {
    logger.error({ error }, '执行出错')
    process.exit(1)
  } finally {
    // 17. 关闭连接
    logger.info('\n【示例】关闭 Redis 连接...')
    await redisClient.disconnect()
    logger.info('【示例】✓ 连接已关闭')
  }
}

// 运行示例
main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
