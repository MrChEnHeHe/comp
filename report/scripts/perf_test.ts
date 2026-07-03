/**
 * 数字遗产管家 — API 与邮件性能测试脚本
 * ===============================
 * 测试内容：
 *   1. API 端点响应时间测试（需后端已启动）
 *   2. 邮件模板生成性能测试（console 模拟模式）
 *
 * 运行方式（从项目根目录或 backend 目录）：
 *   步骤 1：启动后端：cd backend && npm run dev
 *   步骤 2：cd backend && npx ts-node --transpile-only ../report/scripts/perf_test.ts
 */

import { emailService } from '../services/emailService'
import http from 'http'

const API_BASE = 'http://localhost:3000/api'

// ============================================================
// 辅助函数
// ============================================================

function heading(title: string) {
  const bar = '='.repeat(70)
  console.log(`\n${bar}`)
  console.log(`  ${title}`)
  console.log(`${bar}\n`)
}

function subheading(title: string) {
  console.log(`\n--- ${title} ---`)
}

function result(label: string, value: string) {
  console.log(`  ${label}: ${value}`)
}

function msFromNS(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode || 0, body }))
    }).on('error', reject)
  })
}

function httpPost(url: string, data: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(data)
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode || 0, body }))
    })
    req.on('error', reject)
    req.write(json)
    req.end()
  })
}

async function timeApiRequest(fn: () => Promise<any>, iterations: number = 30): Promise<{ avg: number; min: number; max: number; success: number }> {
  let total = 0, min = Infinity, max = 0, success = 0

  // 预热
  for (let i = 0; i < 5; i++) { try { await fn() } catch {} }

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime()
    try {
      await fn()
      const elapsed = msFromNS(process.hrtime(start))
      total += elapsed
      if (elapsed < min) min = elapsed
      if (elapsed > max) max = elapsed
      success++
    } catch { /* 仅记录失败 */ }
  }

  return {
    avg: success > 0 ? total / success : 0,
    min: min === Infinity ? 0 : min,
    max,
    success
  }
}

function formatMs(ms: number): string {
  return ms.toFixed(3) + ' ms'
}

// ============================================================
// 1. API 端点性能测试
// ============================================================

async function testAPIEndpoints() {
  heading('1. API 端点性能测试')

  const ITERATIONS = 30

  // 准备测试数据
  const testEmail = `perf_${Date.now()}@test.com`
  let userId: string | null = null
  let planId: string | null = null

  try {
    // 注册
    const regResp = await httpPost(`${API_BASE}/auth/register`, { name: '性能测试', email: testEmail, password: 'test123' })
    const regData = JSON.parse(regResp.body)
    if (regData.userId) userId = regData.userId

    // 创建计划
    if (userId) {
      const planResp = await httpPost(`${API_BASE}/plans`, {
        name: '性能测试计划', assets: [{ name: 'asset1', type: 'crypto' }],
        guardians: [
          { id: 'g1', name: 'g1', email: 'g1@t.com', role: 'guardian' },
          { id: 'g2', name: 'g2', email: 'g2@t.com', role: 'guardian' },
        ],
        threshold: 2, totalShares: 2, triggerMode: 'consensus', timeLock: 30, creatorId: userId,
      })
      const planData = JSON.parse(planResp.body)
      if (planData.id) planId = planData.id
    }
  } catch(err: any) {
    console.error('  数据准备失败（后端可能未启动）:', err.message)
    return
  }

  // 1.1 健康检查
  subheading('GET /api/health')
  const health = await timeApiRequest(() => httpGet(`${API_BASE}/health`), ITERATIONS)
  result('成功率', `${health.success}/${ITERATIONS}`)
  result('平均耗时', formatMs(health.avg))
  result('最小耗时', formatMs(health.min))
  result('最大耗时', formatMs(health.max))

  // 1.2 获取所有计划
  subheading('GET /api/plans')
  const plans = await timeApiRequest(() => httpGet(`${API_BASE}/plans`), ITERATIONS)
  result('平均耗时', formatMs(plans.avg))
  result('成功率', `${plans.success}/${ITERATIONS}`)

  // 1.3 获取用户计划
  if (userId) {
    subheading('GET /api/plans?userId=xxx')
    const userPlans = await timeApiRequest(() => httpGet(`${API_BASE}/plans?userId=${userId}`), ITERATIONS)
    result('平均耗时', formatMs(userPlans.avg))
  }

  // 1.4 获取单个计划
  if (planId) {
    subheading('GET /api/plans/:id')
    const single = await timeApiRequest(() => httpGet(`${API_BASE}/plans/${planId}`), ITERATIONS)
    result('平均耗时', formatMs(single.avg))
  }

  // 1.5 继承状态
  if (planId) {
    subheading('GET /api/inheritance/:planId')
    const st = await timeApiRequest(() => httpGet(`${API_BASE}/inheritance/${planId}`), ITERATIONS)
    result('平均耗时', formatMs(st.avg))
  }

  // 1.6 用户搜索
  subheading('GET /api/users/search')
  const search = await timeApiRequest(() => httpGet(`${API_BASE}/users/search?q=test`), ITERATIONS)
  result('平均耗时', formatMs(search.avg))

  // 1.7 LLM 状态
  subheading('GET /api/ai/llm/status')
  const llm = await timeApiRequest(() => httpGet(`${API_BASE}/ai/llm/status`), ITERATIONS)
  result('平均耗时', formatMs(llm.avg))
}

// ============================================================
// 2. 邮件模板生成性能测试
// ============================================================

async function testEmailPerformance() {
  heading('2. 邮件模板生成性能测试')

  const ITERATIONS = 100

  const sampleShare = {
    guardianName: '张三', guardianEmail: 'z@test.com', guardianId: 'g001',
    planName: '我的数字遗产', planId: 'p001',
    shareId: 's001', shareIndex: 1,
    shareValue: 'abc123', duressValue: 'xyz789',
    duressBlindingFactor: 'blind001', duressCommitment: 'comm001',
    threshold: 3, totalShares: 5,
  }

  const sampleRefresh = {
    guardianName: '张三', guardianEmail: 'z@test.com', guardianId: 'g001',
    planName: '我的数字遗产', planId: 'p001',
    shareIndex: 1, valueDelta: 'dv001', blindingDelta: 'dr001',
    duressValue: 'new_duress', duressBlindingFactor: 'new_blind',
    duressCommitment: 'new_comm', threshold: 3, totalShares: 5,
  }

  const sampleAlert = {
    guardianName: '张三', guardianEmail: 'z@test.com',
    planName: '我的数字遗产', planId: 'p001', triggeredAt: new Date(),
  }

  async function testTemplate(name: string, fn: () => Promise<any>) {
    subheading(name)
    // 预热
    for (let i = 0; i < 10; i++) await fn()
    let total = 0, min = Infinity, max = 0
    for (let i = 0; i < ITERATIONS; i++) {
      const start = process.hrtime()
      await fn()
      const elapsed = msFromNS(process.hrtime(start))
      total += elapsed
      if (elapsed < min) min = elapsed
      if (elapsed > max) max = elapsed
    }
    result('平均耗时', formatMs(total / ITERATIONS))
    result('最小耗时', formatMs(min))
    result('最大耗时', formatMs(max))
  }

  await testTemplate('份额通知邮件模板', () => emailService.sendShareEmail(sampleShare))
  await testTemplate('份额刷新通知邮件模板', () => emailService.sendRefreshEmail(sampleRefresh))
  await testTemplate('胁迫警报邮件模板', () => emailService.sendDuressAlert(sampleAlert))
  await testTemplate('验证码邮件模板', () => emailService.sendVerificationCodeEmail({
    userName: '张三', userEmail: 'z@test.com', code: '123456', purpose: '登录',
  }))
  await testTemplate('继承通知邮件模板', () => emailService.sendInheritanceNotification({
    guardianName: '张三', guardianEmail: 'z@test.com',
    planName: '我的数字遗产', planId: 'p001', heirAddress: 'heir@test.com',
  }))
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('\n')
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║     数字遗产管家 — 性能测试报告                           ║')
  console.log('║     Digital Legacy Guardian — Performance Test Suite    ║')
  console.log('╚═══════════════════════════════════════════════════════════╝')
  console.log(`  测试时间: ${new Date().toISOString()}`)

  try {
    await testAPIEndpoints()
    await testEmailPerformance()

    heading('✅ 全部测试完成')
  } catch (error: any) {
    console.error('\n❌ 测试执行出错:', error.message)
  }
}

main()
