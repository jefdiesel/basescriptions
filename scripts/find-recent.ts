import { JsonRpcProvider } from 'ethers'
import 'dotenv/config'

const provider = new JsonRpcProvider('https://mainnet.base.org')
const TARGET = '0x58e244c1fc95f59f9e4b71572c0082148129b8d7'

async function main() {
  const block = await provider.getBlockNumber()
  console.log('Current block:', block)
  console.log('Searching last 100 blocks for self-txs from', TARGET)

  for (let b = block; b > block - 1000; b--) {
    const blk = await provider.getBlock(b, true)
    if (blk === null) continue

    for (const tx of blk.prefetchedTransactions || []) {
      const from = tx.from.toLowerCase()
      const to = tx.to?.toLowerCase()

      if (from === TARGET && from === to) {
        try {
          const data = Buffer.from(tx.data.slice(2), 'hex').toString('utf8')
          console.log(`Block ${b}: ${tx.hash}`)
          console.log(`  Data: ${data.slice(0, 80)}`)
        } catch (e) {
          console.log(`Block ${b}: ${tx.hash} (binary data)`)
        }
      }
    }
  }
  console.log('Done')
}

main()
