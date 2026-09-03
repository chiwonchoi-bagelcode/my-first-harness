import 'dotenv/config'
import { createInterface } from 'node:readline/promises'

const token = process.env.AIPROXY_TOKEN

const input = process.argv[2]

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
})

while(true) {
  const input = await terminal.question('> ')

  const response = await fetch(
    'https://aiproxy-api.backoffice.bagelgames.com/api/v1/chat/openai',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: input }],
      }),
    },
  )

  // console.log(result.content)
  // console.log(response)


  const result = await response.json()
  console.log(result.content)
}