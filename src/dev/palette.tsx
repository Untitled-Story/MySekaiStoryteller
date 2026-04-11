import { Fragment } from 'react'
import { Category, Component, Variant, Palette } from '@react-buddy/ide-toolbox'

export const PaletteTree = () => (
  <Palette>
    <Category name="App">
      <Component name="Loader">
        <Variant>
          <ExampleLoaderComponent />
        </Variant>
      </Component>
    </Category>
  </Palette>
)

export function ExampleLoaderComponent() {
  return <Fragment>Loading...</Fragment>
}
