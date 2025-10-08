//
// Created by Tobias Hegemann on 20.09.22.
//

#include "RealtimeRubberBand.h"

#include <algorithm>

const RubberBand::RubberBandStretcher::Options kDefaultOption = RubberBand::RubberBandStretcher::OptionProcessRealTime |
    RubberBand::RubberBandStretcher::OptionPitchHighConsistency |
    RubberBand::RubberBandStretcher::OptionEngineFaster;
const RubberBand::RubberBandStretcher::Options kHighQuality = RubberBand::RubberBandStretcher::OptionProcessRealTime |
    RubberBand::RubberBandStretcher::OptionPitchHighConsistency |
    RubberBand::RubberBandStretcher::OptionEngineFiner;

RealtimeRubberBand::RealtimeRubberBand(size_t sampleRate, size_t channel_count, bool high_quality) :
    start_pad_samples_(0),
    start_delay_samples_(0),
    channel_count_(channel_count),
    max_process_size_(0) {
  if (sampleRate <= 0) {
    throw std::range_error("Sample rate has to be greater than 0");
  }
  if (channel_count <= 0) {
    throw std::range_error("Channel count has to be greater than 0");
  }
  stretcher_ = new RubberBand::RubberBandStretcher(sampleRate, channel_count,
                                                   high_quality ? kHighQuality : kDefaultOption
  );
  output_buffer_ = new RubberBand::RingBuffer<float> *[channel_count_];
  scratch_ = new float *[channel_count_];
  auto buffer_size = kBlockSize_ + kReserve_ + 8192;
  for (size_t channel = 0; channel < channel_count_; ++channel) {
    output_buffer_[channel] = new RubberBand::RingBuffer<float>(buffer_size);
    scratch_[channel] = new float[buffer_size];
  }
  updateRatio();
}

RealtimeRubberBand::~RealtimeRubberBand() {
  delete[] output_buffer_;
  delete[] scratch_;
}

int RealtimeRubberBand::getVersion() {
  return stretcher_->getEngineVersion();
}

void RealtimeRubberBand::setTempo(double tempo) {
  if (tempo <= 0) {
    throw std::range_error("Tempo has to be greater than 0");
  }
  if (stretcher_->getTimeRatio() != tempo) {
    fetchProcessed();
    stretcher_->reset();
    if (max_process_size_ > 0) {
      stretcher_->setMaxProcessSize(max_process_size_);
    }
    stretcher_->setTimeRatio(tempo);
    updateRatio();
  }
}

void RealtimeRubberBand::setPitch(double pitch) {
  if (pitch <= 0) {
    throw std::range_error("Pitch has to be greater than 0");
  }
  if (stretcher_->getPitchScale() != pitch) {
    fetchProcessed();
    stretcher_->reset();
    if (max_process_size_ > 0) {
      stretcher_->setMaxProcessSize(max_process_size_);
    }
    stretcher_->setPitchScale(pitch);
    updateRatio();
  }
}

void RealtimeRubberBand::setFormantScale(double scale) {
  if (scale <= 0) {
    throw std::range_error("Format scale has to be greater than 0");
  }
  if (stretcher_->getFormantScale() != scale) {
    fetchProcessed();
    stretcher_->reset();
    if (max_process_size_ > 0) {
      stretcher_->setMaxProcessSize(max_process_size_);
    }
    stretcher_->setFormantScale(scale);
    updateRatio();
  }
}

void RealtimeRubberBand::setMaxProcessSize(size_t size) {
  max_process_size_ = size;
  stretcher_->setMaxProcessSize(size);
}

__attribute__((unused)) size_t RealtimeRubberBand::getSamplesAvailable() {
  return output_buffer_[0]->getReadSpace();
}

void RealtimeRubberBand::push(uintptr_t input_ptr, size_t sample_size) {
  auto *input = reinterpret_cast<float *>(input_ptr); // NOLINT(performance-no-int-to-ptr)
  auto **arr_to_process = new float *[channel_count_];

  // NOTE: Start padding disabled for fixed-size processing
  // When using setMaxProcessSize(), ALL calls to process() must use the same size
  // Start padding would send variable-sized blocks, violating this contract

  for (size_t channel = 0; channel < channel_count_; ++channel) {
    float *source = input + channel * sample_size;
    arr_to_process[channel] = source;
  }
  stretcher_->process(arr_to_process, sample_size, false);
  delete[] arr_to_process;
  fetchProcessed();
}

__attribute__((unused)) void RealtimeRubberBand::pull(uintptr_t output_ptr, size_t sample_size) {
  auto *output = reinterpret_cast<float *>(output_ptr); // NOLINT(performance-no-int-to-ptr)
  for (size_t channel = 0; channel < channel_count_; ++channel) {
    size_t available = output_buffer_[channel]->getReadSpace();
    if (available == 0) {
      // (!) BUFFER UNDERRUN
      std::cerr << "BUFFER UNDERRUN" << std::endl;
      return;
    }
    float *destination = output + channel * sample_size;
    output_buffer_[channel]->read(
        destination,
        std::min<size_t>(available, sample_size)
    );
  }
}

void RealtimeRubberBand::fetchProcessed() {
  auto available = stretcher_->available();
  if (available > 0) {
    // We have to discard the first start_delay_samples_
    if (start_delay_samples_ > 0) {
      if (available >= start_delay_samples_) {
        stretcher_->retrieve(scratch_, start_delay_samples_);
        available -= start_delay_samples_;
        start_delay_samples_ = 0;
      } else {
        stretcher_->retrieve(scratch_, available);
        start_delay_samples_ -= available;
        return;
      }
    }

    if (output_buffer_[0]->getWriteSpace() <= available) {
      // (!) BUFFER OVERRUN
      std::cerr << "BUFFER OVERRUN" << std::endl;
    }
    size_t actual = stretcher_->retrieve(scratch_, available);
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      output_buffer_[channel]->write(scratch_[channel], actual);
    }
  }
}

void RealtimeRubberBand::updateRatio() {
  start_pad_samples_ = stretcher_->getPreferredStartPad();
  start_delay_samples_ = stretcher_->getStartDelay();
}
