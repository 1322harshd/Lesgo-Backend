import express from 'express';
import 'dotenv/config';

//intializing express app
const app = express()

//setting PORT environment variable
const PORT = process.env.PORT || 3002;

app.get('/', (req, res) => {
  res.send('hello world')
})

app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})
