import { ethers, Wallet, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY!

if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY required in .env')
  process.exit(1)
}

const provider = new JsonRpcProvider(BASE_RPC)
const wallet = new Wallet(PRIVATE_KEY, provider)

function sha256(content: string): string {
  return '0x' + createHash('sha256').update(content).digest('hex')
}

// Register a single ethscription
async function register(name: string): Promise<string> {
  const content = `data:,${name}`
  const data = ethers.hexlify(ethers.toUtf8Bytes(content))

  console.log(`Registering: ${name}`)
  console.log(`  Content: ${content}`)
  console.log(`  Hash: ${sha256(content)}`)

  const tx = await wallet.sendTransaction({
    to: wallet.address, // Self-transfer
    data,
    value: 0
  })

  console.log(`  TX: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`  Confirmed in block ${receipt?.blockNumber}\n`)

  return tx.hash
}

// Register multiple names from command line args
async function main() {
  const names = process.argv.slice(2)

  if (names.length === 0) {
    console.log('Usage: npx tsx scripts/register.ts name1 name2 name3 ...')
    console.log('\nExamples:')
    console.log('  npx tsx scripts/register.ts hello world')
    console.log('  npx tsx scripts/register.ts a b c d e f')
    process.exit(1)
  }

  console.log('Base Ethscriptions Register')
  console.log('===========================\n')
  console.log(`Wallet: ${wallet.address}`)

  const balance = await provider.getBalance(wallet.address)
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`)

  for (const name of names) {
    try {
      await register(name)
    } catch (error: any) {
      console.error(`Failed to register ${name}: ${error.message}\n`)
    }
  }

  console.log('Done!')
}

main().catch(console.error)
