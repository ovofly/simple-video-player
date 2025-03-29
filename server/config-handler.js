import { withConnection } from './db.js'
import postgres from 'postgres'

// 默认配置
export const defaultConfig = {
  resourceSites: [],
  parseApi: '',
  backgroundImage: '',
  enableLogin: false,
  loginPassword: '',
  announcement: '',
  customTitle: ''
}

/**
 * Base64 三次编码
 */
function encodeBase64(str) {
  let encoded = str
  for (let i = 0; i < 3; i++) {
    encoded = Buffer.from(encoded).toString('base64')
  }
  return encoded
}

/**
 * Base64 三次解码
 */
function decodeBase64(str) {
  try {
    let decoded = str
    for (let i = 0; i < 3; i++) {
      decoded = Buffer.from(decoded, 'base64').toString()
    }
    return decoded
  } catch (e) {
    console.error('Base64解码失败:', e)
    return ''
  }
}

/**
 * 确定使用的数据库类型和连接字符串
 * @returns {{type: 'mysql'|'postgresql', connectionString: string}|null}
 */
function getDbConnectionInfo() {
  const sqlDsn = process.env.SQL_DSN
  const pgConnectionString = process.env.PG_CONNECTION_STRING
  
  if (sqlDsn) {
    return { type: 'mysql', connectionString: sqlDsn }
  } else if (pgConnectionString) {
    return { type: 'postgresql', connectionString: pgConnectionString }
  }
  
  return null
}

/**
 * 统一的数据库操作辅助函数
 * @param {function} callback 回调函数
 * @returns {Promise<any>} 回调函数的结果
 */
async function withDatabaseConnection(callback) {
  const connInfo = getDbConnectionInfo()
  
  if (!connInfo) {
    console.log('未提供数据库连接信息')
    return defaultConfig
  }
  
  if (connInfo.type === 'mysql') {
    // 使用MySQL连接
    return await withConnection(connInfo.connectionString, callback)
  } else {
    // 使用PostgreSQL连接
    try {
      const sql = postgres(connInfo.connectionString, {
        max: 1,
        idle_timeout: 2,
        connect_timeout: 5,
        types: {
          jsonb: {
            to: 1184,
            from: [3802],
            serialize: (obj) => JSON.stringify(obj),
            parse: (str) => typeof str === 'string' ? JSON.parse(str) : str
          }
        }
      })
      
      try {
        // 确保表已创建
        await sql`
          CREATE TABLE IF NOT EXISTS configs (
            id SERIAL PRIMARY KEY,
            config JSONB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
        return await callback(sql)
      } finally {
        await sql.end()
      }
    } catch (error) {
      console.error('PostgreSQL操作失败:', error)
      throw error
    }
  }
}

// 获取配置
export async function getConfig() {
  try {
    return await withDatabaseConnection(async (connection) => {
      if (getDbConnectionInfo()?.type === 'mysql') {
        // MySQL查询
        const [rows] = await connection.query('SELECT config FROM configs ORDER BY id DESC LIMIT 1')
        if (Array.isArray(rows) && rows.length > 0) {
          const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
          
          // 如果有密码，在返回前进行三次Base64加密，仅用于传输
          if (config.loginPassword) {
            console.log('对密码进行三次Base64加密用于传输')
            config.loginPassword = encodeBase64(config.loginPassword)
          }
          
          return config
        }
      } else {
        // PostgreSQL查询
        const rows = await connection`SELECT config FROM configs ORDER BY id DESC LIMIT 1`
        if (rows.length > 0) {
          const config = rows[0].config
          
          // 如果有密码，在返回前进行三次Base64加密，仅用于传输
          if (config.loginPassword) {
            console.log('对密码进行三次Base64加密用于传输')
            config.loginPassword = encodeBase64(config.loginPassword)
          }
          
          return config
        }
      }
      return defaultConfig
    }).catch(error => {
      console.error('获取配置失败:', error)
      return defaultConfig
    })
  } catch (error) {
    console.error('获取配置失败:', error)
    return defaultConfig
  }
}

// 更新配置
export async function updateConfig(config) {
  try {
    return await withDatabaseConnection(async (connection) => {
      // 创建配置的副本
      const configToUpdate = { ...config }
      
      // 密码不需要解密，因为前端传来的就是明文密码
      // 数据库中存储的也是明文密码

      if (getDbConnectionInfo()?.type === 'mysql') {
        // MySQL操作
        // 先检查是否存在记录
        const [rows] = await connection.query('SELECT id FROM configs LIMIT 1')
        
        if (rows.length > 0) {
          // 如果存在记录，执行更新
          await connection.query('UPDATE configs SET config = ? WHERE id = ?', [
            JSON.stringify(configToUpdate),
            rows[0].id
          ])
        } else {
          // 如果不存在记录，执行插入
          await connection.query('INSERT INTO configs (config) VALUES (?)', [
            JSON.stringify(configToUpdate)
          ])
        }
      } else {
        // PostgreSQL操作
        // 先检查是否存在记录
        const rows = await connection`SELECT id FROM configs LIMIT 1`
        
        if (rows.length > 0) {
          // 如果存在记录，执行更新
          await connection`UPDATE configs SET config = ${JSON.stringify(configToUpdate)}, updated_at = NOW() WHERE id = ${rows[0].id}`
        } else {
          // 如果不存在记录，执行插入
          await connection`INSERT INTO configs (config) VALUES (${JSON.stringify(configToUpdate)})`
        }
      }
      
      return { success: true, message: '配置更新成功！' }
    }).catch(error => {
      console.error('更新配置失败:', error)
      return { success: false, message: error.message }
    })
  } catch (error) {
    console.error('更新配置失败:', error)
    return { success: false, message: error.message }
  }
}

// 获取公开配置（不包含密码）
export async function getPublicConfig() {
  const config = await getConfig()
  const { loginPassword, ...publicConfig } = config
  return publicConfig
}

// 验证密码（使用明文对比）
export async function verifyPassword(password) {
  try {
    return await withDatabaseConnection(async (connection) => {
      if (getDbConnectionInfo()?.type === 'mysql') {
        // MySQL查询
        const [rows] = await connection.query('SELECT config FROM configs ORDER BY id DESC LIMIT 1')
        if (Array.isArray(rows) && rows.length > 0) {
          const dbConfig = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
          return password === dbConfig.loginPassword
        }
      } else {
        // PostgreSQL查询
        const rows = await connection`SELECT config FROM configs ORDER BY id DESC LIMIT 1`
        if (rows.length > 0) {
          const dbConfig = rows[0].config
          return password === dbConfig.loginPassword
        }
      }
      return true
    }).catch(error => {
      console.error('验证密码失败:', error)
      return false
    })
  } catch (error) {
    console.error('验证密码失败:', error)
    return false
  }
}
