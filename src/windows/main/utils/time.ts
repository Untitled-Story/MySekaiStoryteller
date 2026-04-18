import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)

export function timeAgo(timestamp: number) {
  dayjs.locale('zh-cn')
  return dayjs(timestamp).fromNow()
}
