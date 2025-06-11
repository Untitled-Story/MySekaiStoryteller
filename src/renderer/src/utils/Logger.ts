import { ILogObj, Logger } from 'tslog'

const mainLogger: Logger<ILogObj> = new Logger({
  type: 'pretty',
  prettyLogTemplate:
    '[{{yyyy}}-{{mm}}-{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}][{{logLevelName}}][{{name}}]: ',
  prettyLogTimeZone: 'local'
})

export default function getSubLogger(name: string): Logger<ILogObj> {
  return mainLogger.getSubLogger({ name: name })
}
