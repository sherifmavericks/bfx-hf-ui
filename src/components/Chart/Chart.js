import React from 'react'
import _isEqual from 'lodash/isEqual'
import _capitalize from 'lodash/capitalize'
import { TIME_FRAME_WIDTHS } from 'bfx-hf-util'
import { UserSettings } from 'bfx-hf-ui-config'
import { AutoSizer } from 'react-virtualized'
import BFXChart from 'bfx-hf-chart'
import TradingViewWidget, { Themes } from 'react-tradingview-widget'

import {
  genChartData,
  defaultRangeForTF,
  getDerivedStateFromProps,
} from './helpers'

import Select from '../../ui/Select'
import MarketSelect from '../MarketSelect'
import { getLastCandleUpdate } from '../../redux/selectors/ws'
import { getMarketsForExchange } from '../../redux/selectors/meta'
import nearestMarket from '../../util/nearest_market'
import { propTypes, defaultProps } from './Chart.props'
import './style.css'

const HEIGHT_STEP_PX = 20
const MIN_HEIGHT_PX = 250
const { CHARTS } = UserSettings
const { TRADING_VIEW, BFX_HF_CUSTOM } = CHARTS

export default class Chart extends React.Component {
  static propTypes = propTypes
  static defaultProps = defaultProps
  static getDerivedStateFromProps = getDerivedStateFromProps

  state = {
    candles: [],
    indicators: [],
    drawings: [],
    lastCandleUpdate: null,
    lastInternalCandleUpdate: 0,
    marketDirty: false, // if false, we update w/ saved state
    exchangeDirty: false,
  }

  constructor(props) {
    super(props)

    const {
      savedState = {}, candleData = {}, reduxState, defaultHeight = 350,
      activeMarket, activeExchange, indicators: propIndicators = [],
      disableIndicators,
    } = props

    const {
      currentExchange = activeExchange, currentMarket = activeMarket,
      currentTF = '1m', marketDirty, exchangeDirty, height = defaultHeight,
      indicators = '[]',
    } = savedState

    // NOTE: We don't restore the saved range, as it can be very large depending
    //       on the previous user pans
    const currentRange = defaultRangeForTF(currentTF)
    const start = currentRange[0]
    const candleKey = `${currentTF}:${currentMarket.uiID}`
    const allCandles = Object.values((candleData[currentExchange] || {})[candleKey] || {})
    const candles = allCandles.filter(({ mts }) => mts >= start)

    this.state = {
      ...this.state,

      currentExchange,
      currentMarket,
      currentRange,
      currentTF,
      height,

      marketDirty,
      exchangeDirty,

      // Use prop indicators if management is disabled
      indicators: disableIndicators
        ? propIndicators
        : BFXChart.unserializeIndicators(indicators),

      lastCandleUpdateWhenSyncRequested: null,
      lastCandleUpdate: getLastCandleUpdate(reduxState, {
        exID: currentExchange,
        symbol: currentMarket.restID,
        tf: currentTF,
      }),

      ...genChartData(candles),
    }

    const { onRangeChange, onTFChange } = props

    if (onRangeChange) {
      onRangeChange(currentRange)
    }

    if (onTFChange) {
      onTFChange(currentTF)
    }

    this.chartRef = React.createRef()

    this.onChangeTF = this.onChangeTF.bind(this)
    this.onChangeMarket = this.onChangeMarket.bind(this)
    this.onChangeExchange = this.onChangeExchange.bind(this)
    this.onLoadMore = this.onLoadMore.bind(this)
    this.onAddDrawing = this.onAddDrawing.bind(this)
    this.onAddIndicator = this.onAddIndicator.bind(this)
    this.onDeleteIndicator = this.onDeleteIndicator.bind(this)
    this.onUpdateIndicatorArgs = this.onUpdateIndicatorArgs.bind(this)
    this.onIncreaseHeight = this.onIncreaseHeight.bind(this)
    this.onDecreaseHeight = this.onDecreaseHeight.bind(this)
  }

  componentDidMount() {
    const { addCandlesRequirement, addTradesRequirement } = this.props
    const { currentExchange, currentMarket, currentTF } = this.state

    this.syncData()
    addCandlesRequirement(currentExchange, currentMarket, currentTF)
    addTradesRequirement(currentExchange, currentMarket)
  }

  shouldComponentUpdate(nextProps, nextState) {
    const {
      trades, positions, exchanges, orders, syncRanges,
      indicators: propIndicators,
    } = this.props

    const {
      currentTF, currentExchange, currentMarket, height, drawings,
      lastInternalCandleUpdate, indicators: stateIndicators,
    } = this.state

    if (
      !_isEqual(nextState.indicators, stateIndicators)
      || !_isEqual(nextProps.indicators, propIndicators)
      || !_isEqual(nextProps.syncRanges, syncRanges)
      || !_isEqual(nextState.drawings, drawings)
      || !_isEqual(nextProps.trades, trades)
      || (nextState.currentTF !== currentTF)
      || (nextState.currentExchange !== currentExchange)
      || !_isEqual(nextState.currentMarket, currentMarket)
      || !_isEqual(nextProps.positions, positions)
      || !_isEqual(nextProps.exchanges, exchanges)
      || !_isEqual(nextProps.orders, orders)
      || (nextState.height !== height)
    ) {
      return true
    }

    return nextState.lastInternalCandleUpdate !== lastInternalCandleUpdate
  }

  componentDidUpdate() {
    this.deferSaveState()
  }

  componentWillUnmount() {
    const { removeCandlesRequirement, removeTradesRequirement } = this.props
    const { currentExchange, currentMarket, currentTF } = this.state

    removeCandlesRequirement(currentExchange, currentMarket, currentTF)
    removeTradesRequirement(currentExchange, currentMarket)
  }

  onIncreaseHeight() {
    this.setState(({ height }) => ({
      height: height + HEIGHT_STEP_PX,
    }))

    this.deferSaveState()
  }

  onDecreaseHeight() {
    this.setState(({ height }) => ({
      height: Math.max(height - HEIGHT_STEP_PX, MIN_HEIGHT_PX),
    }))

    this.deferSaveState()
  }

  onAddDrawing(D) {
    this.setState(({ drawings }) => ({
      drawings: [
        new D(this.chartRef.current.chart),
        ...drawings,
      ],
    }))
  }

  onAddIndicator(i) {
    this.setState(({ indicators }) => ({
      indicators: [
        ...indicators,
        i,
      ],
    }))

    this.deferSaveState()
  }

  onDeleteIndicator(index) {
    this.setState(({ indicators }) => {
      const nextIndicators = [...indicators]
      nextIndicators.splice(index, 1)
      return { indicators: nextIndicators }
    })

    this.deferSaveState()
  }

  onUpdateIndicatorArgs(args, index) {
    this.setState(({ indicators }) => {
      const nextIndicators = [...indicators]
      const nextIndicator = [...nextIndicators[index]]

      nextIndicator[1] = args
      nextIndicators[index] = nextIndicator

      return { indicators: nextIndicators }
    })

    this.deferSaveState()
  }

  onCandleSelectionChange() {
    setTimeout(() => {
      this.syncData()
      this.saveState()
    }, 0)
  }

  onChangeTF(tf) {
    const { currentExchange, currentMarket, currentTF } = this.state
    const {
      addCandlesRequirement, removeCandlesRequirement, onTFChange,
    } = this.props

    if (tf === currentTF) {
      return
    }

    this.setState(() => ({
      currentTF: tf,
      currentRange: defaultRangeForTF(tf),
    }))

    removeCandlesRequirement(currentExchange, currentMarket, currentTF)
    addCandlesRequirement(currentExchange, currentMarket, tf)
    this.onCandleSelectionChange()

    if (onTFChange) {
      onTFChange(tf)
    }
  }

  onChangeMarket(market) {
    const { currentExchange, currentMarket, currentTF } = this.state
    const {
      addCandlesRequirement, removeCandlesRequirement, addTradesRequirement,
      removeTradesRequirement,
    } = this.props

    if (market.uiID === currentMarket.uiID) {
      return
    }

    this.setState(() => {
      this.onCandleSelectionChange()

      return {
        currentMarket: market,
        marketDirty: true,
      }
    })

    removeCandlesRequirement(currentExchange, currentMarket, currentTF)
    removeTradesRequirement(currentExchange, currentMarket)
    addCandlesRequirement(currentExchange, market, currentTF)
    addTradesRequirement(currentExchange, market)
  }

  onChangeExchange(option) {
    const { value: exchange } = option
    const { currentExchange, currentMarket, currentTF } = this.state
    const {
      addCandlesRequirement, removeCandlesRequirement, reduxState,
      addTradesRequirement, removeTradesRequirement,
    } = this.props

    if (exchange === currentExchange) {
      return
    }

    const markets = getMarketsForExchange(reduxState, exchange)
    const newMarket = nearestMarket(currentMarket, markets)

    this.setState(() => {
      this.onCandleSelectionChange()

      return {
        currentMarket: newMarket,
        currentExchange: exchange,
        exchangeDirty: true,
        marketDirty: true,
      }
    })

    removeCandlesRequirement(currentExchange, currentMarket, currentTF)
    removeTradesRequirement(currentExchange, currentMarket)
    addCandlesRequirement(exchange, newMarket, currentTF)
    addTradesRequirement(exchange, newMarket)
  }

  onLoadMore() {
    const {
      currentTF, currentRange, lastCandleUpdate,
      lastCandleUpdateWhenSyncRequested,
    } = this.state

    // Already requested new candles
    if (lastCandleUpdate === lastCandleUpdateWhenSyncRequested) {
      return
    }

    const rowsToDownload = 1000 // end - Math.ceil(start)
    const cWidth = TIME_FRAME_WIDTHS[currentTF]

    if (!cWidth) {
      console.error(`unknown candle TF width, cannot sync: ${currentTF}`)
      return
    }

    const newRange = [
      currentRange[0] - (cWidth * rowsToDownload),
      currentRange[0],
    ]

    this.setState(() => ({
      currentRange: newRange,
      lastCandleUpdateWhenSyncRequested: lastCandleUpdate,
    }))

    setTimeout(() => {
      this.onCandleSelectionChange()
    })
  }

  syncData() {
    const { syncCandles } = this.props
    const {
      currentExchange, currentMarket, currentTF, currentRange,
    } = this.state

    syncCandles(currentExchange, currentMarket, currentTF, currentRange)
  }

  deferSaveState() {
    setTimeout(() => {
      this.saveState()
    }, 0)
  }

  saveState() {
    const {
      currentExchange, currentMarket, currentTF, currentRange, marketDirty,
      exchangeDirty, height, indicators,
    } = this.state

    const {
      saveState, layoutID, layoutI, onRangeChange,
    } = this.props

    saveState(layoutID, layoutI, {
      marketDirty,
      exchangeDirty,
      currentExchange,
      currentMarket,
      currentRange,
      currentTF,
      height,
      indicators: BFXChart.serializeIndicators(indicators),
    })

    if (onRangeChange) {
      onRangeChange(currentRange)
    }
  }

  renderExchangeDropdown() {
    const { exchangeDirty, currentExchange } = this.state
    const { exchanges, canChangeExchange } = this.props

    return (
      <Select
        key='exchange-dropdown'
        disabled={!canChangeExchange}
        className={{ yellow: exchangeDirty }}
        onChange={this.onChangeExchange}
        value={{
          label: _capitalize(currentExchange),
          value: currentExchange,
        }}

        options={exchanges.map(ex => ({
          label: _capitalize(ex),
          value: ex,
        }))}
      />
    )
  }

  renderMarketDropdown() {
    const { marketDirty, currentMarket, currentExchange } = this.state
    const { allMarkets, canChangeMarket } = this.props
    const markets = allMarkets[currentExchange] || []

    return (
      <MarketSelect
        key='market-dropdown'
        disabled={!canChangeMarket}
        className={{ yellow: marketDirty }}
        onChange={this.onChangeMarket}
        value={currentMarket}
        markets={markets}
      />
    )
  }

  render() {
    const {
      trades, syncRanges, disableToolbar, disableTopbar, orders, positions,
      disableIndicators, disableIndicatorSettings, indicators: propIndicators,
      chart, activeMarket, showExchange, showMarket,
    } = this.props

    const {
      data, drawings, currentExchange, currentTF, currentMarket,
      indicators: stateIndicators,
    } = this.state

    const { base, quote } = activeMarket
    const isSyncing = !!syncRanges.find(({ exID, symbol, tf }) => (
      exID === currentExchange && symbol === currentMarket.wsID && tf === currentTF
    ))

    const indicators = disableIndicators
      ? propIndicators || []
      : stateIndicators

    const relevantPosition = (positions[currentExchange] || {})[currentMarket.wsID]
    const relevantOrders = Object
      .values(orders[currentExchange] || {})
      .filter(o => o.symbol === currentMarket.wsID)

    switch (chart) {
      case TRADING_VIEW: {
        return (
          <div style={{
            display: 'flex',
            flex: 1,
            backgroundColor: '#131722',
            height: '100%',
          }}
          >
            <TradingViewWidget
              symbol={`${currentExchange.toUpperCase()}:${base}${quote}`}
              theme={Themes.DARK}
              autosize
              allow_symbol_change={false}
              enable_publishing={false}
              hideideas
              save_image={false}
              toolbar_bg='#fff'
            />
          </div>
        )
      }

      case BFX_HF_CUSTOM: {
        return (
          <AutoSizer>
            {({ width, height }) => width > 0 && height > 0 && (
              <BFXChart
                ref={this.chartRef}
                indicators={indicators}
                drawings={drawings}
                candles={data}
                trades={trades}
                orders={relevantOrders}
                position={relevantPosition}
                candleWidth={currentTF}
                width={width}
                height={height}
                onLoadMore={this.onLoadMore}
                onTimeFrameChange={this.onChangeTF}
                onAddIndicator={this.onAddIndicator}
                onUpdateIndicatorArgs={this.onUpdateIndicatorArgs}
                onDeleteIndicator={this.onDeleteIndicator}
                onAddDrawing={this.onAddDrawing}
                marketLabel={currentMarket.uiID}
                disableToolbar={disableToolbar}
                disableTopbar={disableTopbar}
                disableIndicators={disableIndicators}
                disableIndicatorSettings={disableIndicatorSettings}
                isSyncing={isSyncing}
                candleLoadingThreshold={3} // we always get 1 candle when sub'ing
                // bgColor='#111'
                bgColor='#102331'
                config={{
                  AXIS_COLOR: '#444',
                  AXIS_TICK_COLOR: '#00000000',
                }}

                showMarketLabel={!showMarket}
                extraHeaderComponentsLeft={(showExchange || showMarket) && (
                  <div className='hfui-chart__extra-header-components'>
                    {showExchange && this.renderExchangeDropdown()}
                    {showMarket && this.renderMarketDropdown()}
                  </div>
                )}
              />
            )}
          </AutoSizer>
        )
      }

      default: {
        return (
          <p>
            Unknown chart type:
            {chart}
          </p>
        )
      }
    }
  }
}
