import type { JSX } from 'react'
import { Heart, Sparkles } from 'lucide-react'
import logo from '@/assets/logo.png'
import beautyEggsAvatar from '@/assets/avatars/beauty-eggs.jpg'
import guangChenAvatar from '@/assets/avatars/guang-chen.jpg'
import hotwindAvatar from '@/assets/avatars/hotwind.jpg'
import whiteMistAvatar from '@/assets/avatars/white-mist.jpg'
import xiaocaooooAvatar from '@/assets/avatars/xiaocaoooo.jpg'
import { useTranslation } from 'react-i18next'

type Acknowledgement = {
  nickname: string
  description: string
  avatar: string
}

const SPECIAL_THANKS: readonly Acknowledgement[] = [
  {
    nickname: 'Guang_Chen_',
    description: 'May all the beauty be blessed!',
    avatar: guangChenAvatar
  },
  {
    nickname: 'WhiteMist',
    description: '支持日野森志步喵',
    avatar: whiteMistAvatar
  },
  {
    nickname: '_熱風_',
    description: '',
    avatar: hotwindAvatar
  },
  {
    nickname: 'xiaocaoooo',
    description: '好',
    avatar: xiaocaooooAvatar
  },
  {
    nickname: 'BeautyEggs',
    description: '我会一直看着你们',
    avatar: beautyEggsAvatar
  }
]

export default function AboutPage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="relative h-screen overflow-y-auto overscroll-none bg-background select-none scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent">
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-10 py-12">
        <section className="flex flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-500">
          <div className="relative mb-5">
            <div className="absolute inset-2 rounded-[28%] bg-cyan-400/20 blur-2xl" />
            <div className="relative flex size-24 items-center justify-center rounded-[28%] border border-white/60 bg-white/75 shadow-[0_18px_50px_-22px_rgba(8,145,178,0.75)] backdrop-blur-xl dark:border-white/10 dark:bg-white/7">
              <img
                src={logo}
                draggable={false}
                alt="MySekaiStoryteller Logo"
                className="size-20 object-contain drop-shadow-sm"
              />
            </div>
          </div>

          <div className="mb-3 flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-[11px] font-medium tracking-[0.16em] text-muted-foreground shadow-sm backdrop-blur-md">
            <Sparkles className="size-3 text-cyan-500" />
            BUILD {__APP_VERSION__}
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.035em]">MySekaiStoryteller</h1>
        </section>

        <section className="mt-12 animate-in fade-in slide-in-from-bottom-3 duration-500 delay-100 fill-mode-both">
          <div className="mb-5 flex items-end justify-between gap-6">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                <Heart className="size-3.5 fill-rose-400 text-rose-400" />
                Special Thanks
              </div>
              <h2 className="text-2xl font-semibold tracking-[-0.025em]">
                {t('about.specialThanks')}
              </h2>
            </div>
            <p className="hidden text-xs text-muted-foreground sm:block">{t('about.unordered')}</p>
          </div>

          <div className="space-y-3">
            {SPECIAL_THANKS.map(
              (person: Acknowledgement, index: number): JSX.Element => (
                <article
                  key={person.nickname}
                  className="group relative flex items-center gap-5 overflow-hidden rounded-2xl border bg-card/75 px-5 py-4 shadow-[0_12px_35px_-28px_rgba(0,0,0,0.55)] backdrop-blur-sm transition duration-300 hover:translate-x-1 hover:border-foreground/15 hover:shadow-[0_20px_45px_-28px_rgba(0,0,0,0.5)]"
                  style={{ animationDelay: `${160 + index * 70}ms` }}
                >
                  <div className="absolute inset-y-4 left-0 w-px bg-gradient-to-b from-transparent via-foreground/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                  <img
                    src={person.avatar}
                    draggable={false}
                    alt={t('about.avatarAlt', { name: person.nickname })}
                    className="size-14 shrink-0 rounded-full object-cover shadow-lg ring-4 ring-background"
                  />
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold tracking-[-0.015em]">
                      {person.nickname}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {person.description}
                    </p>
                  </div>
                </article>
              )
            )}
            <article className="group relative flex items-center gap-5 overflow-hidden rounded-2xl border border-dashed bg-card/40 px-5 py-4 backdrop-blur-sm transition duration-300 hover:translate-x-1 hover:border-foreground/20 hover:bg-card/70">
              <div className="absolute inset-y-4 left-0 w-px bg-gradient-to-b from-transparent via-rose-400/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-rose-400/10 text-rose-500 ring-4 ring-background dark:bg-rose-400/15 dark:text-rose-300">
                <Heart className="size-5 fill-current" />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold tracking-[-0.015em]">
                  {t('about.you')}
                </h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {t('about.youDescription')}
                </p>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  )
}
