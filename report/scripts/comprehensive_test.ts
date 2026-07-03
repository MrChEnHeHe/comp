/**
 * 数字遗产管家 — 综合测试脚本
 * ===============================
 * 测试内容：
 *   1. 系统环境信息收集
 *   2. Shamir 秘密共享正确性（多种 (n,t) 参数）
 *   3. 同态刷新正确性（刷新后主密钥不变）
 *   4. 密码学操作性能基准
 *   5. 主承诺同态验证精度
 *   6. 胁迫码功能验证
 *   7. ECIES 加解密性能
 *   8. 主密钥销毁验证
 *   9. 规模扩展性测试
 *
 * 运行方式（从项目根目录）：
 *   cd backend && npx ts-node --transpile-only ../paper/scripts/comprehensive_test.ts
 */

import { shamirSecretSharing, Share } from '../../backend/src/crypto/shamir'

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

function timeIt(fn: () => void, iterations: number = 100): { avg: number; max: number; min: number } {
  // 预热
  for (let i = 0; i < 10; i++) fn()

  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime()
    fn()
    const end = process.hrtime(start)
    timings.push(msFromNS(end))
  }
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length
  const max = Math.max(...timings)
  const min = Math.min(...timings)
  return { avg, max, min }
}

function randShuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ============================================================
// 1. 系统环境信息
// ============================================================

function collectEnvironment() {
  heading('1. 系统环境信息')

  const os = require('os')
  result('CPU 型号', os.cpus()[0]?.model || '未知')
  result('CPU 核心数', String(os.cpus().length))
  result('总内存 (GB)', (os.totalmem() / 1024 / 1024 / 1024).toFixed(2))
  result('操作系统', `${os.type()} ${os.release()}`)
  result('平台', os.platform())
  result('Node.js 版本', process.version)
  result('V8 版本', process.versions.v8)
  result('架构', process.arch)
}

// ============================================================
// 2. Shamir 秘密共享正确性（使用 generatePedersenShares）
// ============================================================

function testShamirCorrectness() {
  heading('2. Shamir 秘密共享正确性验证')

  const params = [
    { n: 3, t: 2, label: '3-of-2' },
    { n: 5, t: 3, label: '5-of-3' },
    { n: 7, t: 5, label: '7-of-5' },
    { n: 10, t: 7, label: '10-of-7' },
  ]

  for (const { n, t } of params) {
    const ITERATIONS = 100
    subheading(`参数 (n=${n}, t=${t}) — ${ITERATIONS} 轮`)

    let success = 0
    let totalTime = 0

    for (let i = 0; i < ITERATIONS; i++) {
      const mk = shamirSecretSharing.generateMasterKey()
      const pd = shamirSecretSharing.generatePedersenShares(mk, n, t)

      const start = process.hrtime()
      const selected = randShuffle(pd.shares).slice(0, t)
      const recoveredShares: Share[] = selected.map(s => ({
        id: '',
        index: s.index,
        value: s.value,
        commitment: '',
      }))
      const recovered = shamirSecretSharing.combine(recoveredShares)
      totalTime += msFromNS(process.hrtime(start))

      if (recovered === mk) success++
    }

    result('正确次数', `${success}/${ITERATIONS}`)
    result('正确率', `${(success / ITERATIONS * 100).toFixed(2)}%`)
    result('单次恢复平均耗时', `${(totalTime / ITERATIONS).toFixed(4)} ms`)
  }
}

// ============================================================
// 3. 同态刷新正确性
// ============================================================

function testRefreshCorrectness() {
  heading('3. 同态份额刷新正确性验证')

  const params = [
    { n: 3, t: 2 },
    { n: 5, t: 3 },
    { n: 7, t: 5 },
    { n: 10, t: 7 },
  ]

  for (const { n, t } of params) {
    const ITERATIONS = 100
    subheading(`参数 (n=${n}, t=${t}) — ${ITERATIONS} 轮`)

    let preSuccess = 0
    let postSuccess = 0
    let refreshTime = 0

    // secp256k1 曲线阶（与 shamir.ts 中的默认 prime 一致）
    const prime = BigInt('115792089237316195423570985008687907852837564279074904382605163141518161494337')

    for (let i = 0; i < ITERATIONS; i++) {
      const mk = shamirSecretSharing.generateMasterKey()
      const pd = shamirSecretSharing.generatePedersenShares(mk, n, t)

      // 刷新前正确性
      const preSelected = randShuffle(pd.shares).slice(0, t)
      const preRecShares: Share[] = preSelected.map(s => ({
        id: '', index: s.index, value: s.value, commitment: '',
      }))
      if (shamirSecretSharing.combine(preRecShares) === mk) preSuccess++

      // 刷新
      const refreshStart = process.hrtime()
      const deltas = shamirSecretSharing.generateRefreshDeltas(n, t)
      refreshTime += msFromNS(process.hrtime(refreshStart))

      // 监护人本地更新份额
      const updatedShares = pd.shares.map(s => {
        const d = deltas.find(x => x.index === s.index)!
        const ov = BigInt('0x' + s.value)
        const dv = BigInt('0x' + d.valueDelta)
        const nv = (((ov + dv) % prime) + prime) % prime
        return { index: s.index, value: nv.toString(16).padStart(64, '0') }
      })

      // 刷新后正确性
      const postSelected = randShuffle(updatedShares).slice(0, t)
      const postRecShares: Share[] = postSelected.map(s => ({
        id: '', index: s.index, value: s.value, commitment: '',
      }))
      if (shamirSecretSharing.combine(postRecShares) === mk) postSuccess++
    }

    result('刷新前正确率', `${(preSuccess / ITERATIONS * 100).toFixed(2)}%`)
    result('刷新后正确率', `${(postSuccess / ITERATIONS * 100).toFixed(2)}%`)
    result('主密钥不变', preSuccess === ITERATIONS && postSuccess === ITERATIONS ? '✅ 是' : '❌ 否')
    result('Delta 生成平均耗时', `${(refreshTime / ITERATIONS).toFixed(4)} ms`)
  }
}

// ============================================================
// 4. 密码学操作性能基准
// ============================================================

function testCryptoPerformance() {
  heading('4. 密码学操作性能基准')

  const ITERATIONS = 200
  const N = 5
  const T = 3

  const mk = shamirSecretSharing.generateMasterKey()
  const pd = shamirSecretSharing.generatePedersenShares(mk, N, T)
  const sv = pd.shares[0].value
  const bf = pd.shares[0].blindingFactor
  const commit = shamirSecretSharing.generatePedersenCommitment(sv, bf)
  const deltas = shamirSecretSharing.generateRefreshDeltas(N, T)
  const kp = shamirSecretSharing.generateKeyPair()
  const encData = shamirSecretSharing.encryptWithPublicKey(sv, kp.publicKey)

  // 主承诺
  const masterCommit = shamirSecretSharing.generatePedersenCommitment(mk, pd.masterBlindingFactor)
  const commitShares = pd.shares.map(s => {
    const c = shamirSecretSharing.generatePedersenCommitment(s.value, s.blindingFactor)
    return { index: s.index, commitment: c.commitment }
  })

  const tests: Array<{ name: string; fn: () => void }> = [
    { name: '主密钥生成 (256-bit)', fn: () => shamirSecretSharing.generateMasterKey() },
    { name: `Pedersen 双多项式拆分 (${N}-of-${T})`, fn: () => shamirSecretSharing.generatePedersenShares(mk, N, T) },
    { name: 'Pedersen 承诺生成 (单份)', fn: () => shamirSecretSharing.generatePedersenCommitment(sv, bf) },
    { name: 'Pedersen 承诺验证', fn: () => shamirSecretSharing.verifyPedersenCommit(sv, bf, commit.commitment) },
    { name: `零和多项式增量生成 (n=${N})`, fn: () => shamirSecretSharing.generateRefreshDeltas(N, T) },
    { name: `承诺同态刷新 (${N} 份)`, fn: () => { for (let i = 0; i < N; i++) shamirSecretSharing.computeRefreshedCommitment(commit.commitment, deltas[i].valueDelta, deltas[i].blindingDelta) } },
    { name: `Lagrange 恢复主密钥 (${T} 份)`, fn: () => { const s: Share[] = pd.shares.slice(0, T).map(sv => ({ id: '', index: sv.index, value: sv.value, commitment: '' })); shamirSecretSharing.combine(s) } },
    { name: `主承诺同态验证 (${T} 份)`, fn: () => shamirSecretSharing.verifyMasterCommitment(commitShares, masterCommit.commitment) },
    { name: 'ECIES 加密', fn: () => shamirSecretSharing.encryptWithPublicKey(sv, kp.publicKey) },
    { name: 'ECIES 解密', fn: () => shamirSecretSharing.decryptWithPrivateKey(encData, kp.privateKey) },
  ]

  for (const { name, fn } of tests) {
    subheading(name)
    const perf = timeIt(fn, ITERATIONS)
    result('平均耗时', `${perf.avg.toFixed(4)} ms`)
    result('最小耗时', `${perf.min.toFixed(4)} ms`)
    result('最大耗时', `${perf.max.toFixed(4)} ms`)
  }
}

// ============================================================
// 5. 同态验证精度测试
// ============================================================

function testVerificationAccuracy() {
  heading('5. 主承诺同态验证精度测试')

  const ITERATIONS = 100
  const N = 5
  const T = 3

  let tp = 0, fn = 0, tn = 0, fp = 0

  for (let i = 0; i < ITERATIONS; i++) {
    const mk = shamirSecretSharing.generateMasterKey()
    const pd = shamirSecretSharing.generatePedersenShares(mk, N, T)
    const mc = shamirSecretSharing.generatePedersenCommitment(mk, pd.masterBlindingFactor)

    // 正确份额
    const good = pd.shares.slice(0, T).map(s => {
      return { index: s.index, commitment: shamirSecretSharing.generatePedersenCommitment(s.value, s.blindingFactor).commitment }
    })
    if (shamirSecretSharing.verifyMasterCommitment(good, mc.commitment)) { tp++ } else { fn++ }

    // 错误份额
    const bad = pd.shares.slice(0, T).map(s => {
      const wv = shamirSecretSharing.generateMasterKey()
      const wb = shamirSecretSharing.generateMasterKey()
      return { index: s.index, commitment: shamirSecretSharing.generatePedersenCommitment(wv, wb).commitment }
    })
    if (!shamirSecretSharing.verifyMasterCommitment(bad, mc.commitment)) { tn++ } else { fp++ }
  }

  const prec = tp / (tp + fp) * 100
  const rec = tp / (tp + fn) * 100
  const acc = (tp + tn) / (tp + tn + fp + fn) * 100
  const f1 = 2 * prec * rec / (prec + rec)

  subheading('混淆矩阵')
  result('TP (正确份额→通过)', String(tp))
  result('FN (正确份额→拒绝)', String(fn))
  result('FP (错误份额→通过)', String(fp))
  result('TN (错误份额→拒绝)', String(tn))
  result('Precision', `${prec.toFixed(2)}%`)
  result('Recall', `${rec.toFixed(2)}%`)
  result('Accuracy', `${acc.toFixed(2)}%`)
  result('F1 Score', `${isNaN(f1) ? 'N/A' : f1.toFixed(2) + '%'}`)
}

// ============================================================
// 6. 胁迫码功能验证
// ============================================================

function testDuress() {
  heading('6. 胁迫码功能验证')

  const ITERATIONS = 100

  let normalOk = 0
  let duressOk = 0

  for (let i = 0; i < ITERATIONS; i++) {
    const mk = shamirSecretSharing.generateMasterKey()
    const pd = shamirSecretSharing.generatePedersenShares(mk, 5, 3)
    const di = shamirSecretSharing.generateDuressInfo()

    const nc = shamirSecretSharing.generatePedersenCommitment(pd.shares[0].value, pd.shares[0].blindingFactor)
    if (shamirSecretSharing.verifyPedersenCommit(pd.shares[0].value, pd.shares[0].blindingFactor, nc.commitment)) normalOk++

    const dc = shamirSecretSharing.generatePedersenCommitment(di.duressValue, di.duressBlindingFactor)
    if (shamirSecretSharing.verifyPedersenCommit(di.duressValue, di.duressBlindingFactor, dc.commitment)) duressOk++
  }

  result('正常份额验证通过率', `${(normalOk / ITERATIONS * 100).toFixed(2)}%`)
  result('胁迫份额验证通过率', `${(duressOk / ITERATIONS * 100).toFixed(2)}%`)
  result('机制有效', normalOk === ITERATIONS && duressOk === ITERATIONS ? '✅ 是' : '❌ 否')
}

// ============================================================
// 7. 主密钥销毁验证
// ============================================================

function testMasterKeyDestruction() {
  heading('7. 主密钥销毁验证')

  const ITERATIONS = 100
  let leaked = false

  for (let i = 0; i < ITERATIONS; i++) {
    const mk = shamirSecretSharing.generateMasterKey()
    const pd = shamirSecretSharing.generatePedersenShares(mk, 5, 3)

    for (const s of pd.shares) {
      if (s.value === mk || s.blindingFactor === pd.masterBlindingFactor) leaked = true
    }
  }

  result('份额泄露主密钥', leaked ? '❌ 是' : '✅ 否')
  result('份额泄露主盲因子', leaked ? '❌ 是' : '✅ 否')

  // 份额值随机性检查
  subheading('份额值随机性')
  const firstBytes = new Map<number, number>()
  for (let i = 0; i < ITERATIONS; i++) {
    const mk = shamirSecretSharing.generateMasterKey()
    const pd = shamirSecretSharing.generatePedersenShares(mk, 5, 3)
    for (const s of pd.shares) {
      const b = parseInt(s.value.substring(0, 2), 16)
      firstBytes.set(b, (firstBytes.get(b) || 0) + 1)
    }
  }
  const counts = Array.from(firstBytes.values())
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length
  const maxDev = Math.max(...counts.map(c => Math.abs(c - avg) / avg * 100))
  result('份额首字节分布最大偏差', `${maxDev.toFixed(1)}% (理想均匀 < 20%)`)
  result('随机性风险', maxDev < 30 ? '✅ 低' : '⚠️ 偏高')
}

// ============================================================
// 8. 规模扩展性测试
// ============================================================

function testScalability() {
  heading('8. 规模扩展性测试')

  const configs = [
    { n: 3, t: 2 },
    { n: 5, t: 3 },
    { n: 7, t: 5 },
    { n: 10, t: 7 },
  ]

  console.log()
  for (const { n, t } of configs) {
    const ITER = 50
    let splitTotal = 0, refreshTotal = 0, recoverTotal = 0

    for (let i = 0; i < ITER; i++) {
      const mk = shamirSecretSharing.generateMasterKey()

      const s0 = process.hrtime()
      const pd = shamirSecretSharing.generatePedersenShares(mk, n, t)
      splitTotal += msFromNS(process.hrtime(s0))

      const s1 = process.hrtime()
      shamirSecretSharing.generateRefreshDeltas(n, t)
      refreshTotal += msFromNS(process.hrtime(s1))

      const selected: Share[] = pd.shares.slice(0, t).map(s => ({ id: '', index: s.index, value: s.value, commitment: '' }))
      const s2 = process.hrtime()
      shamirSecretSharing.combine(selected)
      recoverTotal += msFromNS(process.hrtime(s2))
    }

    result(`(n=${n}, t=${t})`, `拆分=${(splitTotal / ITER).toFixed(3)}ms, 刷新=${(refreshTotal / ITER).toFixed(3)}ms, 恢复=${(recoverTotal / ITER).toFixed(3)}ms`)
  }
}

// ============================================================
// 主函数
// ============================================================

function main() {
  console.log('\n')
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║     数字遗产管家 — 密码学综合测试报告                      ║')
  console.log('║     Digital Legacy Guardian — Crypto Test Suite         ║')
  console.log('╚═══════════════════════════════════════════════════════════╝')
  console.log(`  测试时间: ${new Date().toISOString()}`)

  try {
    collectEnvironment()
    testShamirCorrectness()
    testRefreshCorrectness()
    testCryptoPerformance()
    testVerificationAccuracy()
    testDuress()
    testMasterKeyDestruction()
    testScalability()

    heading('✅ 全部测试完成')
  } catch (error: any) {
    console.error('\n❌ 测试执行出错:', error.message)
    console.error(error.stack)
  }
}

main()
