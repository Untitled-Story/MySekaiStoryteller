import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/zh-hk'
import 'dayjs/locale/en'
import 'dayjs/locale/ja'

dayjs.extend(relativeTime)

export function timeAgo(timestamp: number): string {
  return dayjs(timestamp).fromNow()
}
