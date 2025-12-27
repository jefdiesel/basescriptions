import { ethers, Wallet, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY!
const START_INDEX = parseInt(process.env.START_INDEX || '0')

if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY required in .env')
  process.exit(1)
}

const provider = new JsonRpcProvider(BASE_RPC)
const wallet = new Wallet(PRIVATE_KEY, provider)

function sha256(content: string): string {
  return '0x' + createHash('sha256').update(content).digest('hex')
}

async function register(name: string, nonce: number): Promise<boolean> {
  const content = `data:,${name}`
  const data = ethers.hexlify(ethers.toUtf8Bytes(content))

  try {
    const tx = await wallet.sendTransaction({
      to: wallet.address,
      data,
      value: 0,
      nonce
    })
    await tx.wait()
    return true
  } catch (error: any) {
    console.error(`\n  Failed ${name}: ${error.message.slice(0, 60)}`)
    return false
  }
}

async function main() {
  console.log('Base Ethscriptions Batch Register')
  console.log('==================================\n')
  console.log(`Wallet: ${wallet.address}`)

  const balance = await provider.getBalance(wallet.address)
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`)

  const names: string[] = []

  // Single letters a-z
  for (let i = 97; i <= 122; i++) {
    names.push(String.fromCharCode(i))
  }

  // Double letter combos aa-zz
  for (let i = 97; i <= 122; i++) {
    for (let j = 97; j <= 122; j++) {
      names.push(String.fromCharCode(i) + String.fromCharCode(j))
    }
  }

  // Numbers 0-1111
  for (let i = 0; i <= 1111; i++) {
    names.push(i.toString())
  }

  console.log(`Registering ${names.length} names (starting at index ${START_INDEX})...\n`)

  let nonce = await provider.getTransactionCount(wallet.address)
  console.log(`Starting nonce: ${nonce}\n`)

  let success = 0
  let failed = 0
  const failedNames: string[] = []

  for (let i = START_INDEX; i < names.length; i++) {
    const name = names[i]
    process.stdout.write(`\r[${i + 1}/${names.length}] ${name.padEnd(10)} | OK: ${success} | Fail: ${failed}`)

    const ok = await register(name, nonce)
    if (ok) {
      success++
      nonce++
    } else {
      failed++
      failedNames.push(name)
      // Re-fetch nonce on failure
      nonce = await provider.getTransactionCount(wallet.address)
    }

    // Status every 100
    if ((i + 1) % 100 === 0) {
      const bal = await provider.getBalance(wallet.address)
      console.log(`\n  Balance: ${ethers.formatEther(bal)} ETH`)
    }
  }

  console.log(`\n\nDone! Success: ${success}, Failed: ${failed}`)

  if (failedNames.length > 0) {
    console.log(`\nFailed names: ${failedNames.slice(0, 20).join(', ')}${failedNames.length > 20 ? '...' : ''}`)
  }
}

main().catch(console.error)
