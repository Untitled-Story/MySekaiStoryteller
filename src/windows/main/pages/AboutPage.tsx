import type { JSX } from 'react'
import { Sparkles } from 'lucide-react'
import logo from '@/assets/logo.png'
import { useTranslation } from 'react-i18next'
import { isMobileRuntime } from '@/lib/platform'
import { cn } from '@/lib/style'

export default function AboutPage(): JSX.Element {
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()
  return (
    <div
      className={cn(
        'relative h-full overflow-y-auto overscroll-none bg-background select-none scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent',
        mobileRuntime && 'mobile-page-scrollbar'
      )}
    >
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10 pb-12 sm:px-10 sm:py-12">
        <section className="flex flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-500">
          <div className="relative mb-5">
            <div className="absolute inset-2 rounded-[28%] bg-cyan-400/20 blur-2xl" />
            <div className="relative flex size-24 items-center justify-center rounded-[28%] border border-white/60 bg-white/75 shadow-[0_18px_50px_-22px_rgba(8,145,178,0.75)] backdrop-blur-xl dark:border-white/10 dark:bg-white/7">
              <img
                src={logo}
                draggable={false}
                alt={t('common.appLogo')}
                className="size-20 object-contain drop-shadow-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-[11px] font-medium tracking-[0.16em] text-muted-foreground shadow-sm backdrop-blur-md">
            <Sparkles className="size-3 text-cyan-500" />
            BUILD {__APP_VERSION__}
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em]">{t('about.appName')}</h1>
          <p className="mt-2 text-xs tracking-[0.18em] text-muted-foreground">
            {t('about.byline')}
          </p>
          <p className="mt-8 max-w-md text-sm leading-7 text-muted-foreground">
            {t('about.dedication')}
          </p>
        </section>
      </div>
    </div>
  )
}
