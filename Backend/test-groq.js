
import 'dotenv/config';

const response = await fetch(
  'https://api.groq.com/openai/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: `Return only a valid JSON object.
          Respond with a short greeting to Charan.`
        },
        {
          role: 'user',
          content: 'Say hello to Charan.'
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'test_response',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              speech: { type: 'string' },
              takeNote: { type: 'boolean' }
            },
            required: ['speech', 'takeNote'],
            additionalProperties: false
          }
        }
      }
    })
  }
);

console.log('HTTP Status:', response.status);
console.log('Response:', await response.text());
