import 'dotenv/config'
import { createInterface } from 'node:readline/promises'

const token = process.env.AIPROXY_TOKEN

const input = process.argv[2]

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
})


async function step(input: string) {
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

  const result = await response.json();
  return result.content
}

while(true) {
  const input = await terminal.question('> ')

  const output = await step(input)
  // console.log(result.content)
  // console.log(response)


  console.log(output)
}