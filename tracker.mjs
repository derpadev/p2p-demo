import { Server } from 'bittorrent-tracker'

const server = new Server({ udp: false, http: true, ws: true, stats: false })

server.on('error', (err) => console.log('error:', err.message))
server.on('warning', (err) => console.log('warning:', err.message))
server.on('start', (addr) => console.log('peer joined swarm from', addr))
server.on('stop', (addr) => console.log('peer left swarm from', addr))

server.listen(8000, '0.0.0.0', () => {
  console.log('Tracker listening on ws://localhost:8000')
})