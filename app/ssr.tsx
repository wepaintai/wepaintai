/// <reference types="vinxi/types/server" />
import { eventHandler } from 'vinxi/server'
import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { getRouterManifest } from '@tanstack/react-start/router-manifest'
import { createRouter } from './router'

const pageHandler = createStartHandler({
  createRouter,
  getRouterManifest,
})(defaultStreamHandler)

export default eventHandler(async (event) => {
  return pageHandler(event)
})
