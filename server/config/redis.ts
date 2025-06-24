import { createClient, RedisClientType } from 'redis';

let redisClient: RedisClientType | null = null;

export async function connectRedis(): Promise<void> {
  try {
    const config: any = {
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    };

    if (process.env.REDIS_PASSWORD) {
      config.password = process.env.REDIS_PASSWORD;
    }

    redisClient = createClient(config);

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      console.log('✅ Connected to Redis');
    });

    redisClient.on('disconnect', () => {
      console.log('🔌 Disconnected from Redis');
    });

    await redisClient.connect();
  } catch (error) {
    console.error('❌ Failed to connect to Redis:', error);
    // For development, we can continue without Redis
    console.log('⚠️ Continuing without Redis cache');
  }
}

export function getRedis(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call connectRedis() first.');
  }
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    await redisClient.disconnect();
    redisClient = null;
  }
}

// Cache helper functions
export async function setCache(key: string, value: string, expireInSeconds?: number): Promise<void> {
  if (!redisClient || !redisClient.isOpen) return;
  
  try {
    if (expireInSeconds) {
      await redisClient.setEx(key, expireInSeconds, value);
    } else {
      await redisClient.set(key, value);
    }
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

export async function getCache(key: string): Promise<string | null> {
  if (!redisClient || !redisClient.isOpen) return null;
  
  try {
    return await redisClient.get(key);
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

export async function deleteCache(key: string): Promise<void> {
  if (!redisClient || !redisClient.isOpen) return;
  
  try {
    await redisClient.del(key);
  } catch (error) {
    console.error('Redis delete error:', error);
  }
}

export async function existsCache(key: string): Promise<boolean> {
  if (!redisClient || !redisClient.isOpen) return false;
  
  try {
    const result = await redisClient.exists(key);
    return result === 1;
  } catch (error) {
    console.error('Redis exists error:', error);
    return false;
  }
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  await disconnectRedis();
});

process.on('SIGTERM', async () => {
  await disconnectRedis();
});
