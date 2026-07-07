import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { createRouter } from './router'

const pageHandler = createStartHandler({
  createRouter,
})(defaultStreamHandler)

export default pageHandler
